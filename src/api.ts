import type {
  ApiErrorResponse,
  CreateLiveSessionResponse,
  CreateShareResponse,
  ExpirationValue,
  JoinLiveSessionResponse,
  LiveClientSignal,
  PollLiveSignalsResponse,
  ResolveCodeResponse,
  ShareResponse,
} from "../shared/contracts";

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "REQUEST_FAILED", status = 0) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
  }
}

interface CreateShareInput {
  files: File[];
  text: string;
  expiresIn: ExpirationValue;
}

interface UploadOperation {
  promise: Promise<CreateShareResponse>;
  abort: () => void;
}

export function createShare(
  input: CreateShareInput,
  onProgress: (progress: number) => void,
): UploadOperation {
  const request = new XMLHttpRequest();
  const formData = new FormData();
  formData.append("expiresIn", input.expiresIn);
  if (input.text.trim().length > 0) {
    formData.append("text", input.text);
  }
  input.files.forEach((file) => formData.append("files", file, file.name));

  const promise = new Promise<CreateShareResponse>((resolve, reject) => {
    request.open("POST", "/api/shares");
    request.responseType = "json";

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(
          Math.min(100, Math.round((event.loaded / event.total) * 100)),
        );
      }
    });
    request.addEventListener("load", () => {
      const response = request.response as
        CreateShareResponse | ApiErrorResponse | null;
      if (
        request.status >= 200 &&
        request.status < 300 &&
        isCreateShareResponse(response)
      ) {
        onProgress(100);
        resolve(response);
        return;
      }
      reject(toApiError(response, request.status));
    });
    request.addEventListener("error", () => {
      reject(
        new ApiClientError(
          "업로드가 멈췄어요. 연결을 확인하고 다시 시도해 주세요.",
          "NETWORK_ERROR",
        ),
      );
    });
    request.addEventListener("abort", () => {
      reject(new ApiClientError("업로드를 취소했어요.", "UPLOAD_ABORTED"));
    });
    request.send(formData);
  });

  return {
    promise,
    abort: () => request.abort(),
  };
}

export async function getShare(
  code: string,
  signal?: AbortSignal,
): Promise<ShareResponse> {
  let response: Response;
  try {
    response = await fetch(`/api/shares/${encodeURIComponent(code)}`, {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch {
    if (signal?.aborted) {
      throw new ApiClientError("요청을 취소했어요.", "REQUEST_ABORTED");
    }
    throw new ApiClientError(
      "연결할 수 없어요. 잠시 후 다시 시도해 주세요.",
      "NETWORK_ERROR",
    );
  }

  const body = (await response.json().catch(() => null)) as
    ShareResponse | ApiErrorResponse | null;
  if (!response.ok || !isShareResponse(body)) {
    throw toApiError(body, response.status);
  }
  return body;
}

export async function deleteShare(
  code: string,
  managementToken: string,
): Promise<void> {
  await requestJson(`/api/shares/${encodeURIComponent(code)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${managementToken}` },
  });
}

export async function resolveReceiveCode(
  code: string,
  signal?: AbortSignal,
): Promise<ResolveCodeResponse> {
  const body = await requestJson(`/api/codes/${encodeURIComponent(code)}`, {
    signal,
  });
  if (!isResolveCodeResponse(body)) {
    throw new ApiClientError(
      "코드 종류를 확인하지 못했어요. 다시 시도해 주세요.",
      "INVALID_RESPONSE",
    );
  }
  return body;
}

export async function createLiveSession(
  signal?: AbortSignal,
): Promise<CreateLiveSessionResponse> {
  const body = await requestJson("/api/live-sessions", {
    method: "POST",
    signal,
  });
  if (!isCreateLiveSessionResponse(body)) {
    throw new ApiClientError(
      "실시간 연결을 만들지 못했어요. 다시 시도해 주세요.",
      "INVALID_RESPONSE",
    );
  }
  return body;
}

export async function joinLiveSession(
  code: string,
  signal?: AbortSignal,
): Promise<JoinLiveSessionResponse> {
  const body = await requestJson(
    `/api/live-sessions/${encodeURIComponent(code)}/join`,
    { method: "POST", signal },
  );
  if (!isJoinLiveSessionResponse(body)) {
    throw new ApiClientError(
      "실시간 연결에 들어가지 못했어요. 다시 시도해 주세요.",
      "INVALID_RESPONSE",
    );
  }
  return body;
}

export async function postLiveSignal(
  code: string,
  token: string,
  signalMessage: LiveClientSignal,
  signal?: AbortSignal,
): Promise<void> {
  await requestJson(`/api/live-sessions/${encodeURIComponent(code)}/signals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, signal: signalMessage }),
    signal,
  });
}

export async function pollLiveSignals(
  code: string,
  token: string,
  after: number,
  signal?: AbortSignal,
): Promise<PollLiveSignalsResponse> {
  const parameters = new URLSearchParams({
    token,
    after: String(after),
  });
  const body = await requestJson(
    `/api/live-sessions/${encodeURIComponent(code)}/signals?${parameters}`,
    { signal },
  );
  if (!isPollLiveSignalsResponse(body)) {
    throw new ApiClientError(
      "실시간 연결 상태를 확인하지 못했어요.",
      "INVALID_RESPONSE",
    );
  }
  return body;
}

export async function closeLiveSession(
  code: string,
  token: string,
): Promise<void> {
  const parameters = new URLSearchParams({ token });
  let response: Response;
  try {
    response = await fetch(
      `/api/live-sessions/${encodeURIComponent(code)}?${parameters}`,
      { method: "DELETE", keepalive: true },
    );
  } catch {
    return;
  }
  if (!response.ok && response.status !== 404) {
    const body = (await response.json().catch(() => null)) as unknown;
    throw toApiError(body, response.status);
  }
}

async function requestJson(path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: "application/json", ...init.headers },
    });
  } catch {
    if (init.signal?.aborted) {
      throw new ApiClientError("요청을 취소했어요.", "REQUEST_ABORTED");
    }
    throw new ApiClientError(
      "연결할 수 없어요. 잠시 후 다시 시도해 주세요.",
      "NETWORK_ERROR",
    );
  }

  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw toApiError(body, response.status);
  }
  return body;
}

function isShareResponse(value: unknown): value is ShareResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    "files" in value &&
    Array.isArray(value.files)
  );
}

function isCreateShareResponse(value: unknown): value is CreateShareResponse {
  return (
    isShareResponse(value) &&
    "managementToken" in value &&
    typeof value.managementToken === "string" &&
    /^[A-Za-z0-9_-]{32}$/.test(value.managementToken)
  );
}

function isCreateLiveSessionResponse(
  value: unknown,
): value is CreateLiveSessionResponse {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.liveUrl === "string" &&
    typeof value.expiresAt === "string" &&
    typeof value.senderToken === "string" &&
    Array.isArray(value.iceServers)
  );
}

function isResolveCodeResponse(value: unknown): value is ResolveCodeResponse {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    (value.kind === "stored" || value.kind === "live")
  );
}

function isJoinLiveSessionResponse(
  value: unknown,
): value is JoinLiveSessionResponse {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.expiresAt === "string" &&
    typeof value.receiverToken === "string" &&
    Array.isArray(value.iceServers)
  );
}

function isPollLiveSignalsResponse(
  value: unknown,
): value is PollLiveSignalsResponse {
  return (
    isRecord(value) &&
    typeof value.expiresAt === "string" &&
    Array.isArray(value.messages) &&
    value.messages.every(
      (message) =>
        isRecord(message) &&
        typeof message.sequence === "number" &&
        isRecord(message.signal) &&
        typeof message.signal.type === "string",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toApiError(value: unknown, status: number): ApiClientError {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "message" in value.error &&
    typeof value.error.message === "string" &&
    "code" in value.error &&
    typeof value.error.code === "string"
  ) {
    return new ApiClientError(value.error.message, value.error.code, status);
  }
  return new ApiClientError(
    "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.",
    "REQUEST_FAILED",
    status,
  );
}
