export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function invalidInput(message: string): AppError {
  return new AppError(400, "INVALID_INPUT", message);
}

export function payloadTooLarge(): AppError {
  return new AppError(
    413,
    "SHARE_TOO_LARGE",
    "한 번에 올릴 수 있는 용량은 1GB예요.",
  );
}

export function shareNotFound(): AppError {
  return new AppError(404, "SHARE_NOT_FOUND", "코드를 다시 확인해 주세요.");
}
