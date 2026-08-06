import { describe, expect, it } from "vitest";

import { MAX_SHARE_BYTES } from "../shared/contracts";
import {
  LivePayloadAssembler,
  LiveTransferProtocolError,
  createLiveTransferPlan,
  serializeLiveControl,
} from "./live-transfer-protocol";
import { streamLiveTransferPlan, type LiveSenderStatus } from "./live-transfer";

describe("live transfer protocol", () => {
  it("assembles text and multiple file chunks in order", async () => {
    const first = new File([new Uint8Array([1, 2, 3])], "first.bin", {
      type: "application/octet-stream",
    });
    const second = new File(["hello"], "folder/second.txt", {
      type: "text/plain",
    });
    const plan = createLiveTransferPlan("메모", [first, second]);
    const assembler = new LivePayloadAssembler();

    expect(assembler.accept(serializeLiveControl(plan.manifest))).toMatchObject(
      {
        type: "progress",
      },
    );
    for (const entry of plan.files) {
      assembler.accept(
        serializeLiveControl({
          version: 1,
          type: "file-start",
          id: entry.manifest.id,
        }),
      );
      assembler.accept(await entry.file.arrayBuffer());
      assembler.accept(
        serializeLiveControl({
          version: 1,
          type: "file-end",
          id: entry.manifest.id,
        }),
      );
    }
    const completed = assembler.accept(
      serializeLiveControl({ version: 1, type: "complete" }),
    );

    expect(completed.type).toBe("complete");
    if (completed.type !== "complete") return;
    expect(completed.payload.text).toBe("메모");
    expect(completed.payload.files.map((file) => file.name)).toEqual([
      "first.bin",
      "folder_second.txt",
    ]);
    expect(completed.payload.files.map((file) => file.size)).toEqual([3, 5]);
  });

  it("rejects out-of-order and oversized input", () => {
    const assembler = new LivePayloadAssembler();
    expect(() =>
      assembler.accept(
        serializeLiveControl({ version: 1, type: "file-start", id: "file-1" }),
      ),
    ).toThrow(LiveTransferProtocolError);

    const oversized = {
      name: "huge.bin",
      size: MAX_SHARE_BYTES + 1,
      type: "application/octet-stream",
    } as File;
    expect(() => createLiveTransferPlan("", [oversized])).toThrow(
      "한 번에 옮길 수 있는 용량은 1GB예요.",
    );
    const invalidSize = {
      name: "invalid.bin",
      size: Number.NaN,
      type: "application/octet-stream",
    } as File;
    expect(() => createLiveTransferPlan("", [invalidSize])).toThrow(
      "파일 크기를 확인할 수 없어요.",
    );
    expect(() =>
      assembler.accept(
        JSON.stringify({
          version: 1,
          type: "manifest",
          text: "",
          files: [],
          totalBytes: 0,
        }),
      ),
    ).toThrow("상대 기기가 알 수 없는 데이터를 보냈어요.");
  });

  it("reports peer cancellation without completing a payload", () => {
    const assembler = new LivePayloadAssembler();
    expect(
      assembler.accept(
        serializeLiveControl({
          version: 1,
          type: "cancel",
          reason: "보내는 사람이 취소했어요.",
        }),
      ),
    ).toEqual({ type: "cancel", reason: "보내는 사람이 취소했어요." });
  });

  it("streams large files as bounded chunks and waits for a receipt state", async () => {
    const bytes = new Uint8Array(150_000);
    bytes.forEach((_, index) => {
      bytes[index] = index % 251;
    });
    const plan = createLiveTransferPlan("hello", [
      new File([bytes], "large.bin", { type: "application/octet-stream" }),
    ]);
    const sent: Array<string | ArrayBuffer> = [];
    const statuses: LiveSenderStatus[] = [];
    const fakeChannel = {
      readyState: "open",
      bufferedAmount: 0,
      send: (value: string | ArrayBuffer) => sent.push(value),
    } as unknown as RTCDataChannel;

    await streamLiveTransferPlan(
      fakeChannel,
      plan,
      new AbortController().signal,
      {
        onStatus: (status) => statuses.push(status),
        onProgress: () => undefined,
        onError: () => undefined,
      },
    );

    const assembler = new LivePayloadAssembler();
    let completed = null;
    for (const value of sent) {
      const result = assembler.accept(value);
      if (result.type === "complete") completed = result.payload;
    }
    expect(sent.filter((value) => value instanceof ArrayBuffer)).toHaveLength(
      3,
    );
    expect(statuses).toEqual(["sending", "confirming"]);
    expect(completed).not.toBeNull();
    if (!completed) return;
    expect(
      new Uint8Array(await completed.files[0]!.blob.arrayBuffer()),
    ).toEqual(bytes);
  });
});
