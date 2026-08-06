import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_TEXT_BYTES,
  type ApiErrorResponse,
  type CreateLiveSessionResponse,
  type JoinLiveSessionResponse,
  type LiveClientSignal,
  type PollLiveSignalsResponse,
  type ResolveCodeResponse,
  type ShareResponse,
} from "../shared/contracts.js";
import { buildApp } from "./app.js";

interface MultipartField {
  name: string;
  value: string;
}

interface MultipartFile {
  name: string;
  fileName: string;
  contentType: string;
  contents: Buffer;
}

interface TestAppOptions {
  maxShareBytes?: number;
  rateLimit?: boolean;
  uploadTimeoutMs?: number;
  serveClient?: boolean;
  clientDirectory?: string;
  appBaseUrl?: string | false;
  shareCodeGenerator?: () => string;
  liveCodeGenerator?: () => string;
  createFileWriteStream?: (targetPath: string) => Writable;
}

describe("share API", () => {
  const apps: FastifyInstance[] = [];
  const storageDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    await Promise.all(
      storageDirectories.map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
    apps.length = 0;
    storageDirectories.length = 0;
  });

  async function createApp(
    options: TestAppOptions = {},
  ): Promise<FastifyInstance> {
    const storageDirectory = await mkdtemp(path.join(tmpdir(), "move-it-api-"));
    storageDirectories.push(storageDirectory);
    const app = await buildApp({
      storageDirectory,
      ...(options.appBaseUrl === false
        ? {}
        : { appBaseUrl: options.appBaseUrl ?? "https://transfer.test" }),
      cleanupIntervalMs: false,
      maxShareBytes: options.maxShareBytes,
      rateLimit: options.rateLimit ?? false,
      uploadTimeoutMs: options.uploadTimeoutMs,
      serveClient: options.serveClient,
      clientDirectory: options.clientDirectory,
      shareCodeGenerator: options.shareCodeGenerator,
      liveCodeGenerator: options.liveCodeGenerator,
      createFileWriteStream: options.createFileWriteStream,
      now: () => Date.UTC(2026, 6, 22, 12, 0, 0),
    });
    apps.push(app);
    return app;
  }

  it("creates, retrieves, and byte-identically downloads text with two files", async () => {
    const app = await createApp();
    const text = "두 파일과 함께 전달할 텍스트입니다.";
    const files: MultipartFile[] = [
      {
        name: "files",
        fileName: 'report "초안".txt',
        contentType: "text/plain",
        contents: Buffer.from("hello from the first file\n", "utf8"),
      },
      {
        name: "files",
        fileName: "bytes.bin",
        contentType: "application/octet-stream",
        contents: Buffer.from([0x00, 0x0d, 0x0a, 0x80, 0xfe, 0xff]),
      },
    ];
    const multipart = encodeMultipart(
      [
        { name: "expiresIn", value: "1d" },
        { name: "text", value: text },
      ],
      files,
    );

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: multipart.headers,
      payload: multipart.payload,
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json<ShareResponse>();
    expect(created.code).toMatch(/^\d{6}$/);
    expect(created.shareUrl).toBe(`https://transfer.test/s/${created.code}`);
    expect(created.text).toBe(text);
    expect(created.totalBytes).toBe(
      Buffer.byteLength(text) +
        files.reduce((total, file) => total + file.contents.length, 0),
    );
    expect(created.files).toMatchObject([
      {
        name: 'report "초안".txt',
        size: files[0].contents.length,
        mimeType: "text/plain",
      },
      {
        name: "bytes.bin",
        size: files[1].contents.length,
        mimeType: "application/octet-stream",
      },
    ]);

    const lookupResponse = await app.inject({
      method: "GET",
      url: `/api/shares/${created.code}`,
    });
    expect(lookupResponse.statusCode).toBe(200);
    expect(lookupResponse.json<ShareResponse>()).toEqual(created);

    for (const [index, file] of created.files.entries()) {
      const downloadResponse = await app.inject({
        method: "GET",
        url: file.downloadUrl,
      });
      expect(downloadResponse.statusCode).toBe(200);
      expect(downloadResponse.headers["content-type"]).toBe(
        "application/octet-stream",
      );
      expect(downloadResponse.headers["x-content-type-options"]).toBe(
        "nosniff",
      );
      expect(downloadResponse.headers["content-disposition"]).toContain(
        "attachment;",
      );
      if (index === 0) {
        expect(downloadResponse.headers["content-disposition"]).toContain(
          "%22",
        );
      }
      expect(downloadResponse.rawPayload).toEqual(files[index].contents);
    }
  });

  it("creates concurrent shares without code or metadata collisions", async () => {
    const app = await createApp();
    const storageDirectory = storageDirectories.at(-1)!;

    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) => {
        const multipart = encodeMultipart([
          { name: "expiresIn", value: "1d" },
          { name: "text", value: `concurrent-${index}` },
        ]);
        return app.inject({
          method: "POST",
          url: "/api/shares",
          headers: multipart.headers,
          payload: multipart.payload,
        });
      }),
    );

    expect(responses.every((response) => response.statusCode === 201)).toBe(
      true,
    );
    const created = responses.map((response) => response.json<ShareResponse>());
    expect(new Set(created.map((share) => share.code)).size).toBe(8);
    expect(readShareCount(storageDirectory)).toBe(8);
  });

  it("resolves one receive code and keeps stored and live codes unique", async () => {
    const storedCodes = ["700001", "700002", "700003"];
    const liveCodes = ["700001", "700002"];
    const app = await createApp({
      shareCodeGenerator: () => storedCodes.shift()!,
      liveCodeGenerator: () => liveCodes.shift()!,
    });

    const firstMultipart = encodeMultipart([
      { name: "expiresIn", value: "1d" },
      { name: "text", value: "stored-first" },
    ]);
    const firstStoredResponse = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: firstMultipart.headers,
      payload: firstMultipart.payload,
    });
    expect(firstStoredResponse.statusCode).toBe(201);
    expect(firstStoredResponse.json<ShareResponse>().code).toBe("700001");

    const storedResolveResponse = await app.inject({
      method: "GET",
      url: "/api/codes/700001",
    });
    expect(storedResolveResponse.statusCode).toBe(200);
    expect(storedResolveResponse.headers["cache-control"]).toBe("no-store");
    expect(storedResolveResponse.json<ResolveCodeResponse>()).toEqual({
      code: "700001",
      kind: "stored",
    });

    const liveCreateResponse = await app.inject({
      method: "POST",
      url: "/api/live-sessions",
    });
    expect(liveCreateResponse.statusCode).toBe(201);
    expect(liveCreateResponse.json<CreateLiveSessionResponse>().code).toBe(
      "700002",
    );

    const liveResolveResponse = await app.inject({
      method: "GET",
      url: "/api/codes/700002",
    });
    expect(liveResolveResponse.statusCode).toBe(200);
    expect(liveResolveResponse.json<ResolveCodeResponse>()).toEqual({
      code: "700002",
      kind: "live",
    });

    const secondMultipart = encodeMultipart([
      { name: "expiresIn", value: "1d" },
      { name: "text", value: "stored-second" },
    ]);
    const secondStoredResponse = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: secondMultipart.headers,
      payload: secondMultipart.payload,
    });
    expect(secondStoredResponse.statusCode).toBe(201);
    expect(secondStoredResponse.json<ShareResponse>().code).toBe("700003");

    const missingResponse = await app.inject({
      method: "GET",
      url: "/api/codes/999999",
    });
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json<ApiErrorResponse>().error.code).toBe(
      "CODE_NOT_FOUND",
    );

    const malformedResponse = await app.inject({
      method: "GET",
      url: "/api/codes/not-a-code",
    });
    expect(malformedResponse.statusCode).toBe(400);
    expect(malformedResponse.json<ApiErrorResponse>().error.code).toBe(
      "INVALID_INPUT",
    );
  });

  it("coordinates a memory-only live session without storing the text payload", async () => {
    const app = await createApp();
    const storageDirectory = storageDirectories.at(-1)!;

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/live-sessions",
    });
    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.headers["cache-control"]).toBe("no-store");
    const created = createResponse.json<CreateLiveSessionResponse>();
    expect(created.code).toMatch(/^\d{6}$/);
    expect(created.liveUrl).toBe(`https://transfer.test/live/${created.code}`);
    expect(created.senderToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(created.iceServers).toEqual([]);

    const joinResponse = await app.inject({
      method: "POST",
      url: `/api/live-sessions/${created.code}/join`,
    });
    expect(joinResponse.statusCode).toBe(201);
    const joined = joinResponse.json<JoinLiveSessionResponse>();
    expect(joined.receiverToken).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const readyResponse = await app.inject({
      method: "GET",
      url: `/api/live-sessions/${created.code}/signals?token=${created.senderToken}&after=0`,
    });
    expect(readyResponse.statusCode).toBe(200);
    expect(readyResponse.json<PollLiveSignalsResponse>().messages).toEqual([
      { sequence: 1, signal: { type: "peer-ready" } },
    ]);

    const offer: LiveClientSignal = {
      type: "description",
      description: { type: "offer", sdp: "offer-sdp" },
    };
    const offerResponse = await app.inject({
      method: "POST",
      url: `/api/live-sessions/${created.code}/signals`,
      payload: { token: created.senderToken, signal: offer },
    });
    expect(offerResponse.statusCode).toBe(202);

    const receiverSignals = await app.inject({
      method: "GET",
      url: `/api/live-sessions/${created.code}/signals?token=${joined.receiverToken}&after=0`,
    });
    expect(receiverSignals.json<PollLiveSignalsResponse>().messages).toEqual([
      { sequence: 2, signal: offer },
    ]);

    const answer: LiveClientSignal = {
      type: "description",
      description: { type: "answer", sdp: "answer-sdp" },
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/live-sessions/${created.code}/signals`,
          payload: { token: joined.receiverToken, signal: answer },
        })
      ).statusCode,
    ).toBe(202);

    const senderSignals = await app.inject({
      method: "GET",
      url: `/api/live-sessions/${created.code}/signals?token=${created.senderToken}&after=1`,
    });
    expect(senderSignals.json<PollLiveSignalsResponse>().messages).toEqual([
      { sequence: 3, signal: answer },
    ]);

    const secondJoin = await app.inject({
      method: "POST",
      url: `/api/live-sessions/${created.code}/join`,
    });
    expect(secondJoin.statusCode).toBe(409);
    expect(secondJoin.json<ApiErrorResponse>().error.code).toBe(
      "LIVE_SESSION_UNAVAILABLE",
    );

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/live-sessions/${created.code}?token=${created.senderToken}`,
        })
      ).statusCode,
    ).toBe(204);
    const closedCodeResponse = await app.inject({
      method: "GET",
      url: `/api/codes/${created.code}`,
    });
    expect(closedCodeResponse.statusCode).toBe(404);
    expect(closedCodeResponse.json<ApiErrorResponse>().error.code).toBe(
      "CODE_NOT_FOUND",
    );
    expect(readShareCount(storageDirectory)).toBe(0);
  });

  it("validates live signaling bodies and hides invalid peer tokens", async () => {
    const app = await createApp();
    const created = (
      await app.inject({ method: "POST", url: "/api/live-sessions" })
    ).json<CreateLiveSessionResponse>();

    const malformed = await app.inject({
      method: "POST",
      url: `/api/live-sessions/${created.code}/signals`,
      payload: {
        token: created.senderToken,
        signal: { type: "description", description: { type: "offer" } },
      },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<ApiErrorResponse>().error.code).toBe("INVALID_INPUT");

    const invalidToken = await app.inject({
      method: "GET",
      url: `/api/live-sessions/${created.code}/signals?token=${"x".repeat(32)}&after=0`,
    });
    expect(invalidToken.statusCode).toBe(404);
    expect(invalidToken.json<ApiErrorResponse>().error.code).toBe(
      "LIVE_SESSION_NOT_FOUND",
    );
  });

  it("returns 400 for a share with neither text nor files", async () => {
    const app = await createApp();
    const multipart = encodeMultipart([{ name: "expiresIn", value: "1d" }]);

    const response = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: multipart.headers,
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().error.code).toBe("INVALID_INPUT");
  });

  it("returns 400 for a malformed six-digit share code", async () => {
    const app = await createApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/shares/12ab56",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>()).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it("returns 413 when text and file bytes exceed a reduced share limit", async () => {
    const app = await createApp({ maxShareBytes: 10 });
    const multipart = encodeMultipart(
      [
        { name: "expiresIn", value: "1d" },
        { name: "text", value: "123456" },
      ],
      [
        {
          name: "files",
          fileName: "five.bin",
          contentType: "application/octet-stream",
          contents: Buffer.from("12345"),
        },
      ],
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: multipart.headers,
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json<ApiErrorResponse>().error.code).toBe(
      "SHARE_TOO_LARGE",
    );
  });

  it("keeps rate-limit responses as a stable 429 API error", async () => {
    const app = await createApp({ rateLimit: true });
    let response;
    for (let requestIndex = 0; requestIndex < 61; requestIndex += 1) {
      response = await app.inject({
        method: "GET",
        url: "/api/shares/000000",
      });
    }

    expect(response?.statusCode).toBe(429);
    expect(response?.json<ApiErrorResponse>()).toMatchObject({
      error: { code: "RATE_LIMITED" },
    });
  });

  it("reports too many multipart files separately from the byte limit", async () => {
    const app = await createApp();
    const files = Array.from({ length: 51 }, (_, index) => ({
      name: "files",
      fileName: `${index}.txt`,
      contentType: "text/plain",
      contents: Buffer.from("x"),
    }));
    const multipart = encodeMultipart(
      [{ name: "expiresIn", value: "1d" }],
      files,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: multipart.headers,
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().error.code).toBe("TOO_MANY_PARTS");
  });

  it("rejects decoded text that expands beyond the 1 MiB UTF-8 limit", async () => {
    const app = await createApp();
    const multipart = encodeRawTextMultipart(
      Buffer.alloc(MAX_TEXT_BYTES, 0xff),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: multipart.headers,
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json<ApiErrorResponse>().error.code).toBe(
      "SHARE_TOO_LARGE",
    );
  });

  it("returns a stable 400 for multipart data without a boundary", async () => {
    const app = await createApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: { "content-type": "multipart/form-data" },
      payload: "not-a-valid-form",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().error.code).toBe(
      "INVALID_MULTIPART",
    );
  });

  it("rejects a fully received multipart body with a missing closing boundary and cleans temporary files", async () => {
    const app = await createApp();
    const storageDirectory = storageDirectories.at(-1)!;
    const multipart = encodeMultipart(
      [{ name: "expiresIn", value: "1d" }],
      [
        {
          name: "files",
          fileName: "incomplete.bin",
          contentType: "application/octet-stream",
          contents: Buffer.alloc(256, 0x5a),
        },
      ],
    );
    const payload = multipart.payload.subarray(0, multipart.payload.length - 8);

    const response = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: {
        ...multipart.headers,
        "content-length": String(payload.length),
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().error.code).toBe(
      "INVALID_MULTIPART",
    );
    await waitForStorageToBeEmpty(storageDirectory);
  });

  it("finishes writing a fully received file after the request input closes normally", async () => {
    const app = await createApp({
      createFileWriteStream: () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            setTimeout(callback, 25);
          },
        }),
    });
    const multipart = encodeMultipart(
      [{ name: "expiresIn", value: "1d" }],
      [
        {
          name: "files",
          fileName: "buffered.bin",
          contentType: "application/octet-stream",
          contents: Buffer.alloc(256 * 1024, 0x5a),
        },
      ],
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: multipart.headers,
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<ShareResponse>()).toMatchObject({
      totalBytes: 256 * 1024,
      files: [{ name: "buffered.bin", size: 256 * 1024 }],
    });
  });

  it("returns a generic 500 and removes partial data after a disk write failure", async () => {
    const app = await createApp({
      createFileWriteStream: () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            const error = Object.assign(new Error("simulated disk full"), {
              code: "ENOSPC",
            });
            callback(error);
          },
        }),
    });
    const storageDirectory = storageDirectories.at(-1)!;
    const multipart = encodeMultipart(
      [{ name: "expiresIn", value: "1d" }],
      [
        {
          name: "files",
          fileName: "partial.bin",
          contentType: "application/octet-stream",
          contents: Buffer.alloc(256, 0x5a),
        },
      ],
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: multipart.headers,
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json<ApiErrorResponse>()).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "공유를 처리하지 못했어요. 잠시 후 다시 시도해 주세요.",
      },
    });
    expect(response.body).not.toContain("simulated disk full");
    await waitForStorageToBeEmpty(storageDirectory);
  });

  it("rejects a filename whose preserved UTF-8 form exceeds 512 bytes", async () => {
    const app = await createApp();
    const multipart = encodeMultipart(
      [{ name: "expiresIn", value: "1d" }],
      [
        {
          name: "files",
          fileName: "가".repeat(171),
          contentType: "text/plain",
          contents: Buffer.from("x"),
        },
      ],
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: multipart.headers,
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().error.code).toBe("INVALID_INPUT");
  });

  it("validates the request base URL before committing a share", async () => {
    const app = await createApp({ appBaseUrl: false });
    const storageDirectory = storageDirectories.at(-1)!;
    const multipart = encodeMultipart([
      { name: "expiresIn", value: "1d" },
      { name: "text", value: "저장되면 안 되는 텍스트" },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/shares",
      headers: { ...multipart.headers, host: "[" },
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().error.code).toBe("INVALID_INPUT");
    expect(readShareCount(storageDirectory)).toBe(0);
    await expectDirectoryEmpty(path.join(storageDirectory, "tmp"));
  });

  it("never serves the SPA shell for the exact /api path", async () => {
    const clientDirectory = await mkdtemp(
      path.join(tmpdir(), "move-it-client-"),
    );
    storageDirectories.push(clientDirectory);
    await writeFile(
      path.join(clientDirectory, "index.html"),
      "<!doctype html><title>SPA marker</title>",
    );
    const app = await createApp({ serveClient: true, clientDirectory });

    for (const url of ["/api", "/api?probe=1"]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { accept: "text/html" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.body).not.toContain("SPA marker");
    }
  });

  it("keeps the API error envelope when production static serving is enabled", async () => {
    const clientDirectory = await mkdtemp(
      path.join(tmpdir(), "move-it-client-"),
    );
    storageDirectories.push(clientDirectory);
    await writeFile(
      path.join(clientDirectory, "index.html"),
      "<!doctype html><title>SPA marker</title>",
    );
    const app = await createApp({ serveClient: true, clientDirectory });

    const response = await app.inject({
      method: "GET",
      url: "/api/shares/999999",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<ApiErrorResponse>()).toEqual({
      error: {
        code: "SHARE_NOT_FOUND",
        message: "코드를 다시 확인해 주세요.",
      },
    });
  });

  it.each(["field", "file"] as const)(
    "times out a stalled multipart %s request, releases resources, and remains healthy",
    async (kind) => {
      const app = await createApp({ uploadTimeoutMs: 75 });
      const storageDirectory = storageDirectories.at(-1)!;
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as AddressInfo;

      const rawResponse = await sendStalledMultipart(address.port, kind);

      expect(rawResponse).toContain("HTTP/1.1 408 Request Timeout");
      await waitForStorageToBeEmpty(storageDirectory);
      const healthResponse = await app.inject({
        method: "GET",
        url: "/api/health",
      });
      expect(healthResponse.statusCode).toBe(200);
    },
    5_000,
  );
});

function encodeMultipart(
  fields: MultipartField[],
  files: MultipartFile[] = [],
): { headers: Record<string, string>; payload: Buffer } {
  const boundary = `----move-it-vitest-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];

  for (const field of fields) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
        "utf8",
      ),
    );
  }

  for (const file of files) {
    const escapedFileName = file.fileName
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${escapedFileName}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        "utf8",
      ),
      file.contents,
      Buffer.from("\r\n"),
    );
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  const payload = Buffer.concat(chunks);
  return {
    headers: {
      "content-length": String(payload.length),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  };
}

function encodeRawTextMultipart(contents: Buffer): {
  headers: Record<string, string>;
  payload: Buffer;
} {
  const boundary = `----move-it-raw-${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="expiresIn"\r\n\r\n1d\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n`,
    ),
    contents,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return {
    headers: {
      "content-length": String(payload.length),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  };
}

function readShareCount(storageDirectory: string): number {
  const database = new DatabaseSync(
    path.join(storageDirectory, "transfer.sqlite3"),
  );
  try {
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM shares")
      .get() as { count: number } | undefined;
    return row?.count ?? -1;
  } finally {
    database.close();
  }
}

async function expectDirectoryEmpty(directory: string): Promise<void> {
  await expect(readdir(directory)).resolves.toEqual([]);
}

async function waitForStorageToBeEmpty(
  storageDirectory: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const [temporaryEntries, fileEntries] = await Promise.all([
      readdir(path.join(storageDirectory, "tmp")),
      readdir(path.join(storageDirectory, "files")),
    ]);
    if (
      temporaryEntries.length === 0 &&
      fileEntries.length === 0 &&
      readShareCount(storageDirectory) === 0
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Timed-out upload resources were not cleaned up.");
}

function sendStalledMultipart(
  port: number,
  kind: "field" | "file",
): Promise<string> {
  const boundary = "move-it-stalled-boundary";
  const partialBody = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="expiresIn"\r\n\r\n1d\r\n`,
    ),
    kind === "field"
      ? Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nstill-open`,
        )
      : Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="open.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
          ),
          Buffer.alloc(256, 0x5a),
        ]),
  ]);

  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const responseChunks: Buffer[] = [];
    let settled = false;
    const deadline = setTimeout(() => {
      finish(
        new Error("The stalled upload did not receive a timeout response."),
      );
      socket.destroy();
    }, 3_000);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) {
        reject(error);
      } else {
        resolve(Buffer.concat(responseChunks).toString("utf8"));
      }
    };

    socket.once("connect", () => {
      socket.write(
        `POST /api/shares HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: ${partialBody.length + 4096}\r\nConnection: close\r\n\r\n`,
      );
      socket.write(partialBody);
    });
    socket.on("data", (chunk: Buffer) => responseChunks.push(chunk));
    socket.once("end", () => finish());
    socket.once("close", () => {
      if (responseChunks.length > 0) finish();
    });
    socket.once("error", (error) => {
      if (responseChunks.length > 0) finish();
      else finish(error);
    });
  });
}
