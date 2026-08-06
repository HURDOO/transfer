interface RequestInputStream {
  complete: boolean;
  on(event: "close", listener: () => void): unknown;
  removeListener(event: "close", listener: () => void): unknown;
}

export interface UploadRequestSignal {
  signal: AbortSignal;
  dispose: () => void;
}

export function createUploadRequestSignal(
  request: RequestInputStream,
): UploadRequestSignal {
  const controller = new AbortController();
  const onClose = () => {
    if (!request.complete && !controller.signal.aborted) {
      controller.abort();
    }
  };

  request.on("close", onClose);
  return {
    signal: controller.signal,
    dispose: () => request.removeListener("close", onClose),
  };
}
