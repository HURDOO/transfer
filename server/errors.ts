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

export function receiveCodeNotFound(): AppError {
  return new AppError(404, "CODE_NOT_FOUND", "코드를 다시 확인해 주세요.");
}

export function liveSessionNotFound(): AppError {
  return new AppError(
    404,
    "LIVE_SESSION_NOT_FOUND",
    "실시간 코드를 다시 확인해 주세요.",
  );
}

export function liveSessionUnavailable(): AppError {
  return new AppError(
    409,
    "LIVE_SESSION_UNAVAILABLE",
    "이미 다른 기기가 연결했거나 세션을 사용할 수 없어요.",
  );
}
