import {
  MAX_FILE_NAME_BYTES,
  MAX_FILES,
  MAX_SHARE_BYTES,
  MAX_TEXT_BYTES,
} from "../shared/contracts";

export const LIVE_CHUNK_BYTES = 64 * 1024;
export const LIVE_BUFFER_HIGH_WATER_MARK_BYTES = 1024 * 1024;
export const LIVE_BUFFER_LOW_WATER_MARK_BYTES = 256 * 1024;

interface LiveManifestFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
}

export interface LiveTransferManifest {
  version: 1;
  type: "manifest";
  text: string | null;
  files: LiveManifestFile[];
  totalBytes: number;
}

export type LiveTransferControlMessage =
  | LiveTransferManifest
  | { version: 1; type: "file-start"; id: string }
  | { version: 1; type: "file-end"; id: string }
  | { version: 1; type: "complete" }
  | { version: 1; type: "received" }
  | { version: 1; type: "cancel"; reason: string };

export interface LiveTransferPlan {
  manifest: LiveTransferManifest;
  files: Array<{ manifest: LiveManifestFile; file: File }>;
}

export interface LiveReceivedFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  blob: Blob;
}

export interface LiveReceivedPayload {
  text: string | null;
  files: LiveReceivedFile[];
  totalBytes: number;
}

export type LiveAssemblyEvent =
  | { type: "progress"; loadedBytes: number; totalBytes: number }
  | { type: "complete"; payload: LiveReceivedPayload }
  | { type: "cancel"; reason: string }
  | { type: "none" };

export class LiveTransferProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveTransferProtocolError";
  }
}

export function createLiveTransferPlan(
  text: string,
  files: File[],
): LiveTransferPlan {
  if (files.length > MAX_FILES) {
    throw new LiveTransferProtocolError(
      `파일은 한 번에 최대 ${MAX_FILES}개까지 보낼 수 있어요.`,
    );
  }

  const preservedText = text.trim().length > 0 ? text : null;
  const textBytes = preservedText === null ? 0 : byteLength(preservedText);
  if (textBytes > MAX_TEXT_BYTES) {
    throw new LiveTransferProtocolError(
      "텍스트는 최대 1MB까지 보낼 수 있어요.",
    );
  }

  const plannedFiles = files.map((file, index) => {
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new LiveTransferProtocolError("파일 크기를 확인할 수 없어요.");
    }
    const name = sanitizeLiveFileName(file.name);
    if (byteLength(name) > MAX_FILE_NAME_BYTES) {
      throw new LiveTransferProtocolError(
        `파일 이름은 ${MAX_FILE_NAME_BYTES}바이트까지 사용할 수 있어요.`,
      );
    }
    const manifest: LiveManifestFile = {
      id: `file-${index + 1}`,
      name,
      size: file.size,
      mimeType: sanitizeMimeType(file.type),
    };
    return { manifest, file };
  });
  const totalBytes = plannedFiles.reduce(
    (total, entry) => total + entry.manifest.size,
    textBytes,
  );
  if (totalBytes === 0 && preservedText === null && files.length === 0) {
    throw new LiveTransferProtocolError(
      "파일을 고르거나 텍스트를 입력해 주세요.",
    );
  }
  if (totalBytes > MAX_SHARE_BYTES) {
    throw new LiveTransferProtocolError("한 번에 옮길 수 있는 용량은 1GB예요.");
  }

  return {
    manifest: {
      version: 1,
      type: "manifest",
      text: preservedText,
      files: plannedFiles.map((entry) => entry.manifest),
      totalBytes,
    },
    files: plannedFiles,
  };
}

export function serializeLiveControl(
  message: LiveTransferControlMessage,
): string {
  return JSON.stringify(message);
}

export function parseLiveControl(
  value: unknown,
): LiveTransferControlMessage | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.type !== "string"
  ) {
    return null;
  }
  if (parsed.type === "received" || parsed.type === "complete") {
    return { version: 1, type: parsed.type };
  }
  if (parsed.type === "file-start" || parsed.type === "file-end") {
    return typeof parsed.id === "string"
      ? { version: 1, type: parsed.type, id: parsed.id }
      : null;
  }
  if (parsed.type === "cancel") {
    return typeof parsed.reason === "string"
      ? { version: 1, type: "cancel", reason: parsed.reason.slice(0, 200) }
      : null;
  }
  if (parsed.type !== "manifest") return null;
  return parseManifest(parsed);
}

export class LivePayloadAssembler {
  #manifest: LiveTransferManifest | null = null;
  #files: LiveReceivedFile[] = [];
  #current: {
    manifest: LiveManifestFile;
    chunks: ArrayBuffer[];
    receivedBytes: number;
  } | null = null;
  #loadedBytes = 0;
  #complete = false;

  accept(value: string | ArrayBuffer): LiveAssemblyEvent {
    if (this.#complete) {
      throw new LiveTransferProtocolError("이미 끝난 실시간 전송이에요.");
    }
    if (value instanceof ArrayBuffer) {
      return this.#acceptChunk(value);
    }

    const message = parseLiveControl(value);
    if (!message) {
      throw new LiveTransferProtocolError(
        "상대 기기가 알 수 없는 데이터를 보냈어요.",
      );
    }
    return this.#acceptControl(message);
  }

  #acceptControl(message: LiveTransferControlMessage): LiveAssemblyEvent {
    if (message.type === "cancel") {
      this.#complete = true;
      return { type: "cancel", reason: message.reason };
    }
    if (message.type === "received") {
      throw new LiveTransferProtocolError("예상하지 못한 수령 응답이에요.");
    }
    if (message.type === "manifest") {
      if (this.#manifest) {
        throw new LiveTransferProtocolError("전송 정보가 두 번 도착했어요.");
      }
      this.#manifest = message;
      this.#loadedBytes = message.text === null ? 0 : byteLength(message.text);
      return this.#progress();
    }
    if (!this.#manifest) {
      throw new LiveTransferProtocolError(
        "파일 정보보다 데이터가 먼저 도착했어요.",
      );
    }
    if (message.type === "file-start") {
      if (this.#current) {
        throw new LiveTransferProtocolError(
          "이전 파일 전송이 끝나지 않았어요.",
        );
      }
      const expected = this.#manifest.files[this.#files.length];
      if (!expected || expected.id !== message.id) {
        throw new LiveTransferProtocolError("파일 전송 순서가 맞지 않아요.");
      }
      this.#current = { manifest: expected, chunks: [], receivedBytes: 0 };
      return { type: "none" };
    }
    if (message.type === "file-end") {
      if (!this.#current || this.#current.manifest.id !== message.id) {
        throw new LiveTransferProtocolError("끝낼 파일을 확인하지 못했어요.");
      }
      if (this.#current.receivedBytes !== this.#current.manifest.size) {
        throw new LiveTransferProtocolError("파일 일부가 도착하지 않았어요.");
      }
      const { manifest, chunks } = this.#current;
      this.#files.push({
        ...manifest,
        blob: new Blob(chunks, {
          type: manifest.mimeType || "application/octet-stream",
        }),
      });
      this.#current = null;
      return this.#progress();
    }
    if (this.#current || this.#files.length !== this.#manifest.files.length) {
      throw new LiveTransferProtocolError("모든 파일이 도착하지 않았어요.");
    }
    if (this.#loadedBytes !== this.#manifest.totalBytes) {
      throw new LiveTransferProtocolError("전송된 데이터 크기가 맞지 않아요.");
    }
    this.#complete = true;
    return {
      type: "complete",
      payload: {
        text: this.#manifest.text,
        files: this.#files,
        totalBytes: this.#manifest.totalBytes,
      },
    };
  }

  #acceptChunk(chunk: ArrayBuffer): LiveAssemblyEvent {
    if (!this.#manifest || !this.#current) {
      throw new LiveTransferProtocolError(
        "파일 정보 없이 데이터가 도착했어요.",
      );
    }
    const nextFileBytes = this.#current.receivedBytes + chunk.byteLength;
    if (nextFileBytes > this.#current.manifest.size) {
      throw new LiveTransferProtocolError(
        "파일 크기보다 많은 데이터가 도착했어요.",
      );
    }
    const nextTotal = this.#loadedBytes + chunk.byteLength;
    if (nextTotal > this.#manifest.totalBytes || nextTotal > MAX_SHARE_BYTES) {
      throw new LiveTransferProtocolError("실시간 전송 용량 제한을 넘었어요.");
    }
    this.#current.chunks.push(chunk);
    this.#current.receivedBytes = nextFileBytes;
    this.#loadedBytes = nextTotal;
    return this.#progress();
  }

  #progress(): LiveAssemblyEvent {
    return {
      type: "progress",
      loadedBytes: this.#loadedBytes,
      totalBytes: this.#manifest?.totalBytes ?? 0,
    };
  }
}

function parseManifest(
  value: Record<string, unknown>,
): LiveTransferManifest | null {
  if (
    (value.text !== null && typeof value.text !== "string") ||
    !Array.isArray(value.files) ||
    typeof value.totalBytes !== "number" ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 0 ||
    value.totalBytes > MAX_SHARE_BYTES ||
    value.files.length > MAX_FILES
  ) {
    return null;
  }
  const text = value.text as string | null;
  if (text !== null && text.trim().length === 0) return null;
  const textBytes = text === null ? 0 : byteLength(text);
  if (textBytes > MAX_TEXT_BYTES) return null;

  const files: LiveManifestFile[] = [];
  const ids = new Set<string>();
  for (const candidate of value.files) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      candidate.id.length < 1 ||
      candidate.id.length > 80 ||
      ids.has(candidate.id) ||
      typeof candidate.name !== "string" ||
      candidate.name.length < 1 ||
      byteLength(candidate.name) > MAX_FILE_NAME_BYTES ||
      typeof candidate.size !== "number" ||
      !Number.isSafeInteger(candidate.size) ||
      candidate.size < 0 ||
      typeof candidate.mimeType !== "string" ||
      candidate.mimeType.length > 256
    ) {
      return null;
    }
    ids.add(candidate.id);
    files.push({
      id: candidate.id,
      name: sanitizeLiveFileName(candidate.name),
      size: candidate.size,
      mimeType: sanitizeMimeType(candidate.mimeType),
    });
  }
  const expectedBytes = files.reduce(
    (total, file) => total + file.size,
    textBytes,
  );
  if (
    expectedBytes !== value.totalBytes ||
    (expectedBytes === 0 && text === null && files.length === 0)
  ) {
    return null;
  }
  return {
    version: 1,
    type: "manifest",
    text,
    files,
    totalBytes: value.totalBytes,
  };
}

function sanitizeLiveFileName(value: string): string {
  const name = value
    .replace(/[\\/]/g, "_")
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();
  return name || "file";
}

function sanitizeMimeType(value: string): string {
  return /^[\x20-\x7e]{1,256}$/.test(value) ? value : "";
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
