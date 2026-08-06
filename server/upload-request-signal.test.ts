import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { createUploadRequestSignal } from "./upload-request-signal.js";

class RequestInput extends EventEmitter {
  complete = false;
}

describe("upload request signal", () => {
  it("does not abort after a proxy finishes a complete request body", () => {
    const request = new RequestInput();
    const upload = createUploadRequestSignal(request);

    request.complete = true;
    request.emit("close");

    expect(upload.signal.aborted).toBe(false);
    upload.dispose();
    expect(request.listenerCount("close")).toBe(0);
  });

  it("aborts when the request closes before its body is complete", () => {
    const request = new RequestInput();
    const upload = createUploadRequestSignal(request);

    request.emit("close");

    expect(upload.signal.aborted).toBe(true);
    upload.dispose();
  });
});
