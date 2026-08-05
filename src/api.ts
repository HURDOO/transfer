import type {
  ApiErrorResponse,
  ExpirationValue,
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
  promise: Promise<ShareResponse>;
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

  const promise = new Promise<ShareResponse>((resolve, reject) => {
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
        ShareResponse | ApiErrorResponse | null;
      if (
        request.status >= 200 &&
        request.status < 300 &&
        isShareResponse(response)
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
