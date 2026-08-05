import fastifyMultipart from "@fastify/multipart";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { createWriteStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Writable } from "node:stream";

import {
  EXPIRATION_MILLISECONDS,
  MAX_FILE_NAME_BYTES,
  MAX_FILES,
  MAX_SHARE_BYTES,
  MAX_TEXT_BYTES,
  isExpirationValue,
  type ApiErrorResponse,
  type ExpirationValue,
  type ShareResponse,
} from "../shared/contracts.js";
import {
  AppError,
  invalidInput,
  payloadTooLarge,
  shareNotFound,
} from "./errors.js";
import {
  sanitizeFileName,
  ShareStore,
  type ShareReservation,
  type StoredFile,
  type StoredShare,
} from "./share-store.js";

const CODE_PATTERN = /^\d{6}$/;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 30 * 60 * 1_000;

interface BuildAppOptions {
  storageDirectory: string;
  appBaseUrl?: string;
  maxShareBytes?: number;
  logger?: boolean;
  rateLimit?: boolean;
  serveClient?: boolean;
  clientDirectory?: string;
  cleanupIntervalMs?: number | false;
  uploadTimeoutMs?: number;
  now?: () => number;
  createFileWriteStream?: (targetPath: string) => Writable;
}

interface ShareParams {
  code: string;
}

interface FileParams extends ShareParams {
  fileId: string;
}

interface UploadState {
  expiresIn: ExpirationValue | null;
  text: string | null;
  files: StoredFile[];
  totalBytes: number;
}

export async function buildApp(
  options: BuildAppOptions,
): Promise<FastifyInstance> {
  const maxShareBytes = Math.min(
    options.maxShareBytes ?? MAX_SHARE_BYTES,
    MAX_SHARE_BYTES,
  );
  if (!Number.isSafeInteger(maxShareBytes) || maxShareBytes < 1) {
    throw new Error("maxShareBytes must be a positive safe integer.");
  }
  const uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(uploadTimeoutMs) || uploadTimeoutMs < 1) {
    throw new Error("uploadTimeoutMs must be a positive safe integer.");
  }
  const appBaseUrl = options.appBaseUrl
    ? parseConfiguredBaseUrl(options.appBaseUrl)
    : undefined;
  const createFileWriteStream =
    options.createFileWriteStream ??
    ((targetPath: string) =>
      createWriteStream(targetPath, { flags: "wx", mode: 0o600 }));
  const app = Fastify({
    logger: options.logger
      ? {
          redact: {
            paths: ["req.url"],
            censor: "[redacted]",
          },
        }
      : false,
    bodyLimit: maxShareBytes + 2 * 1024 * 1024,
    requestTimeout: uploadTimeoutMs,
    http: {
      connectionsCheckingInterval: Math.min(uploadTimeoutMs, 30_000),
    },
  });
  const store = new ShareStore(options.storageDirectory, { now: options.now });
  const useRateLimit = options.rateLimit ?? true;

  await store.initialize();
  const cleanupResult = await store.cleanup({ removeOrphansImmediately: true });
  if (cleanupResult.removed > 0) {
    app.log.info({ removed: cleanupResult.removed }, "Expired shares removed");
  }

  await app.register(fastifyMultipart, {
    throwFileSizeLimit: true,
    limits: {
      fields: 2,
      files: MAX_FILES,
      parts: MAX_FILES + 2,
      fileSize: maxShareBytes,
      fieldSize: MAX_TEXT_BYTES,
      headerPairs: 200,
    },
  });

  if (useRateLimit) {
    await app.register(fastifyRateLimit, {
      global: false,
      max: 60,
      timeWindow: "1 minute",
    });
  }

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    reply.header(
      "Permissions-Policy",
      "camera=(), geolocation=(), microphone=()",
    );
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    return payload;
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AppError) {
      if (error.code === "UPLOAD_TIMEOUT") {
        reply.header("Connection", "close");
      }
      return sendError(reply, error.statusCode, error.code, error.message);
    }

    const errorCode = readErrorProperty(error, "code");
    const errorStatusCode = readErrorProperty(error, "statusCode");

    if (
      errorCode === "FST_FILES_LIMIT" ||
      errorCode === "FST_PARTS_LIMIT" ||
      errorCode === "FST_FIELDS_LIMIT"
    ) {
      return sendError(
        reply,
        400,
        "TOO_MANY_PARTS",
        `파일은 한 번에 최대 ${MAX_FILES}개까지 보낼 수 있어요.`,
      );
    }

    if (isInvalidMultipartError(error)) {
      return sendError(
        reply,
        400,
        "INVALID_MULTIPART",
        "업로드 요청 형식을 확인해 주세요.",
      );
    }

    if (errorStatusCode === 413 || errorCode === "FST_REQ_FILE_TOO_LARGE") {
      return sendError(
        reply,
        413,
        "SHARE_TOO_LARGE",
        "한 번에 올릴 수 있는 용량은 1GB예요.",
      );
    }

    if (errorStatusCode === 429) {
      return sendError(
        reply,
        429,
        "RATE_LIMITED",
        "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.",
      );
    }

    if (
      typeof errorStatusCode === "number" &&
      errorStatusCode >= 400 &&
      errorStatusCode < 500
    ) {
      return sendError(
        reply,
        errorStatusCode,
        "INVALID_REQUEST",
        "요청 형식을 확인해 주세요.",
      );
    }

    request.log.error(error);
    return sendError(
      reply,
      500,
      "INTERNAL_ERROR",
      "공유를 처리하지 못했어요. 잠시 후 다시 시도해 주세요.",
    );
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  app.post(
    "/api/shares",
    {
      config: useRateLimit
        ? { rateLimit: { max: 10, timeWindow: "1 minute" } }
        : undefined,
    },
    async (request, reply) => {
      if (!request.isMultipart()) {
        throw invalidInput("multipart/form-data 요청이 필요해요.");
      }

      const responseBaseUrl = getBaseUrl(request, appBaseUrl);
      const reservation = await store.reserve();

      let share: StoredShare;
      try {
        const state = await receiveUpload(
          request,
          reservation,
          store,
          maxShareBytes,
          uploadTimeoutMs,
          createFileWriteStream,
        );
        const createdAtMs = options.now?.() ?? Date.now();
        const createdAt = new Date(createdAtMs).toISOString();
        const expiresAt = getExpirationDate(state.expiresIn, createdAtMs);
        share = await store.commit(reservation, {
          createdAt,
          expiresAt,
          text: state.text,
          totalBytes: state.totalBytes,
          files: state.files,
        });
      } catch (error) {
        await store.abort(reservation).catch((cleanupError: unknown) => {
          request.log.error(
            cleanupError,
            "Failed to remove an incomplete share",
          );
        });
        throw error;
      }

      const response = toShareResponse(share, responseBaseUrl);
      return reply.code(201).send(response);
    },
  );

  app.get<{ Params: ShareParams }>(
    "/api/shares/:code",
    {
      config: useRateLimit
        ? { rateLimit: { max: 60, timeWindow: "1 minute" } }
        : undefined,
    },
    async (request) => {
      const share = await findShare(store, request.params.code);
      return toShareResponse(share, getBaseUrl(request, appBaseUrl));
    },
  );

  app.get<{ Params: FileParams }>(
    "/api/shares/:code/files/:fileId",
    {
      config: useRateLimit
        ? { rateLimit: { max: 120, timeWindow: "1 minute" } }
        : undefined,
    },
    async (request, reply) => {
      const share = await findShare(store, request.params.code);
      const file = share.files.find(
        (candidate) => candidate.id === request.params.fileId,
      );
      const storedPath = store.getStoredFilePath(
        share.id,
        request.params.fileId,
      );

      if (!file || !storedPath) {
        throw shareNotFound();
      }

      let fileHandle: FileHandle | undefined;
      let fileSize: number;
      try {
        fileHandle = await open(storedPath, "r");
        const fileStat = await fileHandle.stat();
        if (!fileStat.isFile()) {
          throw new Error("Stored path is not a regular file.");
        }
        fileSize = fileStat.size;
      } catch (error) {
        await fileHandle?.close().catch(() => undefined);
        request.log.error(
          { err: error, shareId: share.id },
          "Stored file is unavailable",
        );
        throw shareNotFound();
      }

      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Length", fileSize);
      reply.header(
        "Content-Disposition",
        createAttachmentHeader(file.originalName),
      );
      return reply.send(fileHandle.createReadStream());
    },
  );

  if (options.serveClient) {
    const clientDirectory = path.resolve(
      options.clientDirectory ?? path.join(process.cwd(), "dist/client"),
    );
    await app.register(fastifyStatic, {
      root: clientDirectory,
      wildcard: false,
    });

    app.setNotFoundHandler(async (request, reply) => {
      if (isApiPath(request.url)) {
        return sendNotFound(reply);
      }

      if (
        request.method === "GET" &&
        request.headers.accept?.includes("text/html")
      ) {
        return reply.sendFile("index.html");
      }

      return sendNotFound(reply);
    });
  } else {
    app.setNotFoundHandler(async (_request, reply) => sendNotFound(reply));
  }

  const cleanupIntervalMs = options.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS;
  if (cleanupIntervalMs !== false) {
    const timer = setInterval(() => {
      void store.cleanup().catch((error: unknown) => {
        app.log.error(error, "Failed to clean expired shares");
      });
    }, cleanupIntervalMs);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }

  app.addHook("onClose", async () => store.close());

  return app;
}

async function receiveUpload(
  request: FastifyRequest,
  reservation: ShareReservation,
  store: ShareStore,
  maxShareBytes: number,
  uploadTimeoutMs: number,
  createFileWriteStream: (targetPath: string) => Writable,
): Promise<UploadState> {
  const state: UploadState = {
    expiresIn: null,
    text: null,
    files: [],
    totalBytes: 0,
  };
  let forcedError: AppError | undefined;
  const interruptMultipart = (error: AppError) => {
    if (forcedError) return;
    forcedError = error;
    request.raw.emit("error", error);
  };
  const uploadTimer = setTimeout(() => {
    interruptMultipart(
      new AppError(
        408,
        "UPLOAD_TIMEOUT",
        "업로드 시간이 초과됐어요. 다시 시도해 주세요.",
      ),
    );
  }, uploadTimeoutMs);
  uploadTimer.unref();
  const parts = request.parts({
    limits: {
      fields: 2,
      files: MAX_FILES,
      parts: MAX_FILES + 2,
      fileSize: maxShareBytes,
      fieldSize: MAX_TEXT_BYTES,
    },
  });

  try {
    for await (const part of parts) {
      if (part.type === "field") {
        const value =
          typeof part.value === "string" ? part.value : String(part.value);
        if (part.valueTruncated) {
          throw payloadTooLarge();
        }

        if (part.fieldname === "expiresIn") {
          if (state.expiresIn !== null || !isExpirationValue(value)) {
            throw invalidInput("만료 기한을 다시 선택해 주세요.");
          }
          state.expiresIn = value;
          continue;
        }

        if (part.fieldname === "text") {
          if (state.text !== null) {
            throw invalidInput("텍스트는 한 번만 보낼 수 있어요.");
          }
          if (value.trim().length > 0) {
            const textBytes = Buffer.byteLength(value, "utf8");
            if (textBytes > MAX_TEXT_BYTES) {
              throw payloadTooLarge();
            }
            state.totalBytes += textBytes;
            ensureWithinLimit(state.totalBytes, maxShareBytes);
            state.text = value;
          }
          continue;
        }

        throw invalidInput(`알 수 없는 필드예요: ${part.fieldname}`);
      }

      if (part.fieldname !== "files") {
        part.file.resume();
        throw invalidInput("파일 필드 이름은 files여야 해요.");
      }
      if (part.file.destroyed && !part.file.readableEnded) {
        throw new AppError(
          400,
          "INVALID_MULTIPART",
          "업로드 요청 형식을 확인해 주세요.",
        );
      }

      const originalName = sanitizeFileName(part.filename);
      if (Buffer.byteLength(originalName, "utf8") > MAX_FILE_NAME_BYTES) {
        part.file.resume();
        throw invalidInput("파일 이름은 UTF-8 기준 512바이트 이하여야 해요.");
      }

      const target = store.createFileTarget(reservation);
      let fileBytes = 0;
      const byteLimiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          fileBytes += chunk.length;
          state.totalBytes += chunk.length;
          if (state.totalBytes > maxShareBytes) {
            callback(payloadTooLarge());
            return;
          }
          callback(null, chunk);
        },
      });

      await pipeline(
        part.file,
        byteLimiter,
        createFileWriteStream(target.path),
        { signal: request.signal },
      );
      if (part.file.truncated) {
        throw payloadTooLarge();
      }

      state.files.push({
        id: target.id,
        originalName,
        size: fileBytes,
        mimeType: part.mimetype.slice(0, 255),
      });
    }

    if (state.expiresIn === null) {
      throw invalidInput("만료 기한을 선택해 주세요.");
    }
    if (state.files.length === 0 && state.text === null) {
      throw invalidInput("파일을 고르거나 텍스트를 입력해 주세요.");
    }

    return state;
  } catch (error) {
    if (forcedError) throw forcedError;
    throw error;
  } finally {
    clearTimeout(uploadTimer);
  }
}

async function findShare(
  store: ShareStore,
  code: string,
): Promise<StoredShare> {
  if (!CODE_PATTERN.test(code)) {
    throw invalidInput("6자리 숫자를 입력해 주세요.");
  }
  const share = await store.get(code);
  if (!share) {
    throw shareNotFound();
  }
  return share;
}

function getExpirationDate(
  expiresIn: ExpirationValue | null,
  createdAt: number,
): string | null {
  if (expiresIn === null) {
    throw invalidInput("만료 기한을 선택해 주세요.");
  }
  if (expiresIn === "never") {
    return null;
  }
  return new Date(createdAt + EXPIRATION_MILLISECONDS[expiresIn]).toISOString();
}

function ensureWithinLimit(totalBytes: number, maxShareBytes: number): void {
  if (totalBytes > maxShareBytes) {
    throw payloadTooLarge();
  }
}

function toShareResponse(share: StoredShare, baseUrl: URL): ShareResponse {
  const shareUrl = new URL(`/s/${share.code}`, baseUrl);
  return {
    code: share.code,
    shareUrl: shareUrl.toString(),
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    text: share.text,
    totalBytes: share.totalBytes,
    files: share.files.map((file) => ({
      id: file.id,
      name: file.originalName,
      size: file.size,
      mimeType: file.mimeType,
      downloadUrl: `/api/shares/${share.code}/files/${file.id}`,
    })),
  };
}

function getBaseUrl(request: FastifyRequest, configuredBaseUrl?: URL): URL {
  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }

  const origin = request.headers.origin;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.protocol === "http:" || originUrl.protocol === "https:") {
        return originUrl;
      }
    } catch {
      // Fall back to the request host below.
    }
  }

  try {
    return new URL(`${request.protocol}://${request.host}`);
  } catch {
    throw invalidInput("요청 주소를 확인해 주세요.");
  }
}

function parseConfiguredBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("APP_BASE_URL must use http or https.");
  }
  return url;
}

function createAttachmentHeader(fileName: string): string {
  const normalized = fileName.replace(/["\\\r\n]/g, "_");
  const ascii = normalized.replace(/[^\x20-\x7e]/g, "_") || "file";
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function sendNotFound(reply: FastifyReply): FastifyReply {
  return sendError(reply, 404, "NOT_FOUND", "요청한 내용을 찾을 수 없어요.");
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
): FastifyReply {
  const body: ApiErrorResponse = { error: { code, message } };
  return reply.code(statusCode).send(body);
}

function readErrorProperty(
  error: unknown,
  property: "code" | "statusCode",
): unknown {
  if (typeof error !== "object" || error === null || !(property in error)) {
    return undefined;
  }
  return (error as Record<string, unknown>)[property];
}

function isApiPath(url: string): boolean {
  return url === "/api" || url.startsWith("/api?") || url.startsWith("/api/");
}

function isInvalidMultipartError(error: unknown): boolean {
  const code = readErrorProperty(error, "code");
  if (code === "FST_PROTO_VIOLATION" || code === "FST_MP_PREMATURE_CLOSE") {
    return true;
  }

  const message = error instanceof Error ? error.message : "";
  return /boundary not found|unexpected end of (?:form|multipart data)|premature close/i.test(
    message,
  );
}
