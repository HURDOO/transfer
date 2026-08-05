import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createShareCode,
  sanitizeFileName,
  ShareStore,
  type ShareReservation,
  type StoredFile,
} from "./share-store.js";

const FIXED_TIME = Date.UTC(2026, 6, 22, 12, 0, 0);

describe("ShareStore", () => {
  const stores: ShareStore[] = [];
  const storageDirectories: string[] = [];

  afterEach(async () => {
    for (const store of stores) {
      store.close();
    }
    await Promise.all(
      storageDirectories.map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
    stores.length = 0;
    storageDirectories.length = 0;
  });

  async function createStorageDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "move-it-store-"));
    storageDirectories.push(directory);
    return directory;
  }

  function track(store: ShareStore): ShareStore {
    stores.push(store);
    return store;
  }

  it("keeps SQLite metadata and file bytes after the store is restarted", async () => {
    const directory = await createStorageDirectory();
    const fileBytes = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);
    const firstStore = track(
      new ShareStore(directory, {
        now: () => FIXED_TIME,
        codeGenerator: () => "000042",
      }),
    );
    const reservation = await firstStore.reserve();
    const file = await writeReservedFile(
      firstStore,
      reservation,
      "restart.bin",
      fileBytes,
    );

    const created = await firstStore.commit(reservation, {
      createdAt: new Date(FIXED_TIME).toISOString(),
      expiresAt: null,
      text: "재시작 뒤에도 남는 텍스트",
      totalBytes:
        fileBytes.length + Buffer.byteLength("재시작 뒤에도 남는 텍스트"),
      files: [file],
    });
    firstStore.close();

    const restartedStore = track(
      new ShareStore(directory, { now: () => FIXED_TIME + 1_000 }),
    );
    await restartedStore.initialize();

    const restored = await restartedStore.get("000042");

    expect(restored).toEqual(created);
    const restoredPath = restartedStore.getStoredFilePath(created.id, file.id);
    expect(restoredPath).not.toBeNull();
    await expect(readFile(restoredPath!)).resolves.toEqual(fileBytes);
  });

  it("rejects and removes a share as soon as its expiration time is reached", async () => {
    let now = FIXED_TIME;
    const directory = await createStorageDirectory();
    const store = track(
      new ShareStore(directory, {
        now: () => now,
        codeGenerator: () => "100001",
      }),
    );
    const reservation = await store.reserve();
    const created = await store.commit(reservation, {
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 1_000).toISOString(),
      text: "곧 만료되는 공유",
      totalBytes: Buffer.byteLength("곧 만료되는 공유"),
      files: [],
    });

    await expect(store.get(created.code)).resolves.toEqual(created);

    now += 1_000;
    await expect(store.get(created.code)).resolves.toBeNull();
    await expect(store.get(created.code)).resolves.toBeNull();
  });

  it("retries a colliding code and preserves six-digit codes with leading zeroes", async () => {
    const generatedCodes = ["000001", "000001", "000002"];
    const directory = await createStorageDirectory();
    const store = track(
      new ShareStore(directory, {
        codeGenerator: () => generatedCodes.shift() ?? "999999",
      }),
    );

    const firstReservation = await store.reserve();
    const first = await store.commit(firstReservation, {
      createdAt: new Date(FIXED_TIME).toISOString(),
      expiresAt: null,
      text: "first",
      totalBytes: 5,
      files: [],
    });
    const secondReservation = await store.reserve();
    const second = await store.commit(secondReservation, {
      createdAt: new Date(FIXED_TIME).toISOString(),
      expiresAt: null,
      text: "second",
      totalBytes: 6,
      files: [],
    });

    expect(first.code).toBe("000001");
    expect(second.code).toBe("000002");
    expect(first.code).toMatch(/^\d{6}$/);
    expect(second.code).toMatch(/^\d{6}$/);
  });

  it("removes crash orphans immediately during startup cleanup", async () => {
    const directory = await createStorageDirectory();
    const store = track(new ShareStore(directory, { now: () => FIXED_TIME }));
    await store.initialize();
    const orphanId = "11111111-1111-4111-8111-111111111111";
    const orphanDirectory = path.join(store.filesDirectory, orphanId);
    await mkdir(orphanDirectory, { recursive: true });

    const result = await store.cleanup({ removeOrphansImmediately: true });

    expect(result.removed).toBe(1);
    await expect(access(orphanDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not remove an in-progress reservation during cleanup", async () => {
    const directory = await createStorageDirectory();
    const store = track(new ShareStore(directory, { now: () => FIXED_TIME }));
    const reservation = await store.reserve();

    await store.cleanup({ removeOrphansImmediately: true });

    await expect(access(reservation.filesDirectory)).resolves.toBeUndefined();
    await store.abort(reservation);
  });

  it("keeps committed files when immediate cleanup overlaps a commit", async () => {
    const directory = await createStorageDirectory();
    const store = track(
      new ShareStore(directory, {
        now: () => FIXED_TIME,
        codeGenerator: () => "200001",
      }),
    );
    const reservation = await store.reserve();
    const contents = Buffer.from("commit-cleanup-race", "utf8");
    const file = await writeReservedFile(
      store,
      reservation,
      "race.txt",
      contents,
    );

    const [created] = await Promise.all([
      store.commit(reservation, {
        createdAt: new Date(FIXED_TIME).toISOString(),
        expiresAt: null,
        text: null,
        totalBytes: contents.length,
        files: [file],
      }),
      store.cleanup({ removeOrphansImmediately: true }),
    ]);

    await expect(store.get(created.code)).resolves.toEqual(created);
    const storedPath = store.getStoredFilePath(created.id, file.id);
    await expect(readFile(storedPath!)).resolves.toEqual(contents);
  });

  it("rolls back metadata and removes promoted files after a commit failure", async () => {
    const directory = await createStorageDirectory();
    const store = track(
      new ShareStore(directory, {
        now: () => FIXED_TIME,
        codeGenerator: () => "300001",
      }),
    );
    const reservation = await store.reserve();
    const contents = Buffer.from("rollback-me", "utf8");
    const file = await writeReservedFile(
      store,
      reservation,
      "rollback.txt",
      contents,
    );

    await expect(
      store.commit(reservation, {
        createdAt: new Date(FIXED_TIME).toISOString(),
        expiresAt: null,
        text: null,
        totalBytes: contents.length,
        files: [file, file],
      }),
    ).rejects.toThrow();

    await expect(store.get("300001")).resolves.toBeNull();
    await expect(readdir(store.temporaryDirectory)).resolves.toEqual([]);
    await expect(readdir(store.filesDirectory)).resolves.toEqual([]);
  });
});

describe("share storage helpers", () => {
  it("always creates an exactly six-digit numeric code", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(createShareCode()).toMatch(/^\d{6}$/);
    }
  });

  it("keeps only a safe leaf filename and supplies a fallback", () => {
    expect(sanitizeFileName("../../secret\\folder/report\u0000\r\n.txt")).toBe(
      "report.txt",
    );
    expect(sanitizeFileName("\u0000\r\n\t")).toBe("file");
    expect(sanitizeFileName("가".repeat(200))).toHaveLength(200);
  });
});

async function writeReservedFile(
  store: ShareStore,
  reservation: ShareReservation,
  originalName: string,
  contents: Buffer,
): Promise<StoredFile> {
  const target = store.createFileTarget(reservation);
  await writeFile(target.path, contents);
  return {
    id: target.id,
    originalName,
    size: contents.length,
    mimeType: "application/octet-stream",
  };
}
