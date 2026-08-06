import { afterEach, describe, expect, it, vi } from "vitest";

import type { CreateShareResponse } from "../shared/contracts";
import {
  createLiveTransferRecord,
  createStoredTransferRecord,
  reconcileTransferExpiration,
} from "./share-history";

describe("sent transfer history", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a stored share management token only while it is active", () => {
    const share: CreateShareResponse = {
      code: "123456",
      shareUrl: "https://transfer.test/s/123456",
      createdAt: "2026-08-07T00:00:00.000Z",
      expiresAt: "2026-08-08T00:00:00.000Z",
      text: "private text",
      totalBytes: 12,
      files: [
        {
          id: "file-id",
          name: "hello.txt",
          size: 12,
          mimeType: "text/plain",
          downloadUrl: "/api/files/file-id",
        },
      ],
      managementToken: "a".repeat(32),
    };
    const record = createStoredTransferRecord(share);

    expect(record).toMatchObject({
      status: "active",
      code: "123456",
      managementToken: "a".repeat(32),
      fileNames: ["hello.txt"],
      textIncluded: true,
    });
    expect(record).not.toHaveProperty("text");

    expect(
      reconcileTransferExpiration(record, Date.parse(share.expiresAt!)),
    ).toMatchObject({
      status: "expired",
      code: null,
      managementToken: null,
    });
  });

  it("stores completed live metadata without a reusable code", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "history-id" });
    const record = createLiveTransferRecord({
      createdAt: "2026-08-07T00:00:00.000Z",
      fileNames: ["one.bin"],
      textIncluded: false,
      totalBytes: 42,
    });

    expect(record).toMatchObject({
      id: "live:2026-08-07T00:00:00.000Z:history-id",
      kind: "live",
      status: "completed",
      code: null,
      managementToken: null,
    });
  });
});
