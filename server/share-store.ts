import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";
import path from "node:path";

import { AppError } from "./errors.js";

const CODE_PATTERN = /^\d{6}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANAGEMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const MANAGEMENT_TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const SCHEMA_VERSION = 2;
const DEFAULT_STALE_RESERVATION_MS = 60 * 60 * 1_000;

const SCHEMA = `
  CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE
      CHECK(length(code) = 6 AND code NOT GLOB '*[^0-9]*'),
    created_at TEXT NOT NULL,
    expires_at TEXT,
    shared_text TEXT,
    total_bytes INTEGER NOT NULL CHECK(total_bytes >= 0),
    management_token_hash TEXT
      CHECK(
        management_token_hash IS NULL OR
        (
          length(management_token_hash) = 64 AND
          management_token_hash NOT GLOB '*[^0-9a-f]*'
        )
      )
  ) STRICT;

  CREATE TABLE share_files (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
    mime_type TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    UNIQUE(share_id, ordinal)
  ) STRICT;

  CREATE INDEX shares_expires_at_index ON shares(expires_at)
    WHERE expires_at IS NOT NULL;

  PRAGMA user_version = 2;
`;

const MIGRATE_SCHEMA_V1_TO_V2 = `
  ALTER TABLE shares ADD COLUMN management_token_hash TEXT
    CHECK(
      management_token_hash IS NULL OR
      (
        length(management_token_hash) = 64 AND
        management_token_hash NOT GLOB '*[^0-9a-f]*'
      )
    );
  PRAGMA user_version = 2;
`;

export interface StoredFile {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
}

export interface StoredShare {
  id: string;
  code: string;
  createdAt: string;
  expiresAt: string | null;
  text: string | null;
  totalBytes: number;
  files: StoredFile[];
}

export interface ShareReservation {
  id: string;
  temporaryDirectory: string;
  filesDirectory: string;
}

interface ShareStoreOptions {
  now?: () => number;
  codeGenerator?: () => string;
  isCodeUnavailable?: (code: string) => boolean;
  staleReservationMs?: number;
}

interface CommitShareMetadata extends Omit<StoredShare, "id" | "code"> {
  managementToken?: string;
}

interface CleanupOptions {
  removeOrphansImmediately?: boolean;
}

interface ShareRow {
  id: string;
  code: string;
  created_at: string;
  expires_at: string | null;
  shared_text: string | null;
  total_bytes: number;
}

interface FileRow {
  id: string;
  original_name: string;
  size_bytes: number;
  mime_type: string;
}

export class ShareStore {
  readonly rootDirectory: string;
  readonly databasePath: string;
  readonly temporaryDirectory: string;
  readonly filesDirectory: string;

  private readonly now: () => number;
  private readonly codeGenerator: () => string;
  private readonly isCodeUnavailable: (code: string) => boolean;
  private readonly staleReservationMs: number;
  private readonly activeReservations = new Set<string>();
  private database: DatabaseSync | null = null;

  constructor(rootDirectory: string, options: ShareStoreOptions = {}) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.databasePath = path.join(this.rootDirectory, "transfer.sqlite3");
    this.temporaryDirectory = path.join(this.rootDirectory, "tmp");
    this.filesDirectory = path.join(this.rootDirectory, "files");
    this.now = options.now ?? Date.now;
    this.codeGenerator = options.codeGenerator ?? createShareCode;
    this.isCodeUnavailable = options.isCodeUnavailable ?? (() => false);
    this.staleReservationMs =
      options.staleReservationMs ?? DEFAULT_STALE_RESERVATION_MS;
  }

  async initialize(): Promise<void> {
    if (this.database) {
      return;
    }

    await mkdir(this.temporaryDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.filesDirectory, { recursive: true, mode: 0o700 });

    const database = new DatabaseSync(this.databasePath, {
      timeout: 5_000,
      enableForeignKeyConstraints: true,
      allowExtension: false,
      defensive: true,
    });
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
    `);

    const schemaVersion = readSchemaVersion(database);
    if (schemaVersion === 0) {
      try {
        database.exec(`BEGIN IMMEDIATE; ${SCHEMA} COMMIT;`);
      } catch (error) {
        if (database.isTransaction) {
          database.exec("ROLLBACK");
        }
        database.close();
        throw error;
      }
    } else if (schemaVersion === 1) {
      try {
        database.exec(`BEGIN IMMEDIATE; ${MIGRATE_SCHEMA_V1_TO_V2} COMMIT;`);
      } catch (error) {
        if (database.isTransaction) {
          database.exec("ROLLBACK");
        }
        database.close();
        throw error;
      }
    } else if (schemaVersion !== SCHEMA_VERSION) {
      database.close();
      throw new Error(
        `Unsupported SQLite schema version ${schemaVersion}; expected ${SCHEMA_VERSION}.`,
      );
    }

    this.database = database;
  }

  close(): void {
    if (!this.database) {
      return;
    }
    this.database.close();
    this.database = null;
  }

  async reserve(): Promise<ShareReservation> {
    await this.initialize();
    const id = randomUUID();
    const temporaryDirectory = path.join(this.temporaryDirectory, id);
    const filesDirectory = path.join(temporaryDirectory, "files");
    await mkdir(filesDirectory, { recursive: true, mode: 0o700 });
    this.activeReservations.add(id);
    return { id, temporaryDirectory, filesDirectory };
  }

  createFileTarget(reservation: ShareReservation): {
    id: string;
    path: string;
  } {
    const id = randomUUID();
    return {
      id,
      path: path.join(reservation.filesDirectory, id),
    };
  }

  async commit(
    reservation: ShareReservation,
    metadata: CommitShareMetadata,
    maxCodeAttempts = 40,
  ): Promise<StoredShare> {
    const database = this.getDatabase();
    const finalDirectory = path.join(this.filesDirectory, reservation.id);
    const { managementToken, ...shareMetadata } = metadata;
    const managementTokenHash = managementToken
      ? hashManagementToken(managementToken)
      : null;

    try {
      await rename(reservation.temporaryDirectory, finalDirectory);
      const committedAt = new Date(this.now());
      await utimes(finalDirectory, committedAt, committedAt);

      for (let attempt = 0; attempt < maxCodeAttempts; attempt += 1) {
        const code = this.codeGenerator();
        if (!CODE_PATTERN.test(code)) {
          throw new Error("The share code generator returned an invalid code.");
        }
        if (this.isCodeUnavailable(code)) {
          continue;
        }

        database.exec("BEGIN IMMEDIATE");
        try {
          const insertResult = database
            .prepare(
              `
                INSERT OR IGNORE INTO shares (
                  id, code, created_at, expires_at, shared_text, total_bytes,
                  management_token_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
              `,
            )
            .run(
              reservation.id,
              code,
              shareMetadata.createdAt,
              shareMetadata.expiresAt,
              shareMetadata.text,
              shareMetadata.totalBytes,
              managementTokenHash,
            );

          if (!didChange(insertResult)) {
            database.exec("ROLLBACK");
            continue;
          }

          const insertFile = database.prepare(
            `
              INSERT INTO share_files (
                id, share_id, original_name, size_bytes, mime_type, ordinal
              ) VALUES (?, ?, ?, ?, ?, ?)
            `,
          );
          shareMetadata.files.forEach((file, ordinal) => {
            insertFile.run(
              file.id,
              reservation.id,
              file.originalName,
              file.size,
              file.mimeType,
              ordinal,
            );
          });
          database.exec("COMMIT");

          return {
            id: reservation.id,
            code,
            ...shareMetadata,
          };
        } catch (error) {
          if (database.isTransaction) {
            database.exec("ROLLBACK");
          }
          throw error;
        }
      }

      throw new AppError(
        503,
        "CODE_UNAVAILABLE",
        "공유 코드를 만들지 못했어요. 잠시 후 다시 시도해 주세요.",
      );
    } catch (error) {
      await rm(finalDirectory, { recursive: true, force: true });
      throw error;
    } finally {
      this.activeReservations.delete(reservation.id);
    }
  }

  async abort(reservation: ShareReservation): Promise<void> {
    try {
      await Promise.all([
        rm(reservation.temporaryDirectory, { recursive: true, force: true }),
        rm(path.join(this.filesDirectory, reservation.id), {
          recursive: true,
          force: true,
        }),
      ]);
    } finally {
      this.activeReservations.delete(reservation.id);
    }
  }

  async get(code: string): Promise<StoredShare | null> {
    if (!CODE_PATTERN.test(code)) {
      return null;
    }

    const database = this.getDatabase();
    const rawShare = database
      .prepare(
        `
          SELECT id, code, created_at, expires_at, shared_text, total_bytes
          FROM shares
          WHERE code = ?
        `,
      )
      .get(code);

    if (!rawShare) {
      return null;
    }

    const shareRow = parseShareRow(rawShare);
    if (isExpired(shareRow.expires_at, this.now())) {
      await this.removeShare(shareRow.id);
      return null;
    }

    const rawFiles = database
      .prepare(
        `
          SELECT id, original_name, size_bytes, mime_type
          FROM share_files
          WHERE share_id = ?
          ORDER BY ordinal ASC
        `,
      )
      .all(shareRow.id);

    return {
      id: shareRow.id,
      code: shareRow.code,
      createdAt: shareRow.created_at,
      expiresAt: shareRow.expires_at,
      text: shareRow.shared_text,
      totalBytes: shareRow.total_bytes,
      files: rawFiles.map(parseFileRow).map((file) => ({
        id: file.id,
        originalName: file.original_name,
        size: file.size_bytes,
        mimeType: file.mime_type,
      })),
    };
  }

  hasActiveCode(code: string): boolean {
    if (!CODE_PATTERN.test(code)) return false;
    const rawShare = this.getDatabase()
      .prepare("SELECT expires_at FROM shares WHERE code = ?")
      .get(code);
    if (!rawShare || !isRecord(rawShare)) return false;
    const expiresAt = rawShare.expires_at;
    return isNullableString(expiresAt) && !isExpired(expiresAt, this.now());
  }

  async removeManagedShare(
    code: string,
    managementToken: string,
  ): Promise<boolean> {
    if (
      !CODE_PATTERN.test(code) ||
      !MANAGEMENT_TOKEN_PATTERN.test(managementToken)
    ) {
      return false;
    }

    const rawShare = this.getDatabase()
      .prepare(
        "SELECT id, expires_at, management_token_hash FROM shares WHERE code = ?",
      )
      .get(code);
    if (!rawShare || !isRecord(rawShare)) return false;

    const id = rawShare.id;
    const expiresAt = rawShare.expires_at;
    const expectedHash = rawShare.management_token_hash;
    if (
      typeof id !== "string" ||
      !isNullableString(expiresAt) ||
      (expectedHash !== null && typeof expectedHash !== "string")
    ) {
      throw new Error("SQLite returned invalid managed share metadata.");
    }
    if (isExpired(expiresAt, this.now())) {
      await this.removeShare(id);
      return false;
    }
    if (
      expectedHash === null ||
      !MANAGEMENT_TOKEN_HASH_PATTERN.test(expectedHash)
    ) {
      return false;
    }

    const actualHash = hashManagementToken(managementToken);
    if (
      !timingSafeEqual(
        Buffer.from(actualHash, "hex"),
        Buffer.from(expectedHash, "hex"),
      )
    ) {
      return false;
    }

    await this.removeShare(id);
    return true;
  }

  getStoredFilePath(shareId: string, fileId: string): string | null {
    if (!UUID_PATTERN.test(shareId) || !UUID_PATTERN.test(fileId)) {
      return null;
    }
    return path.join(this.filesDirectory, shareId, "files", fileId);
  }

  async cleanup(options: CleanupOptions = {}): Promise<{ removed: number }> {
    await this.initialize();
    const database = this.getDatabase();
    const nowIso = new Date(this.now()).toISOString();
    const expiredRows = database
      .prepare(
        `SELECT id FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .all(nowIso);
    let removed = 0;

    for (const rawRow of expiredRows) {
      const id = readStringColumn(rawRow, "id");
      await this.removeShare(id);
      removed += 1;
    }

    const activeIds = new Set(
      database
        .prepare("SELECT id FROM shares")
        .all()
        .map((row) => readStringColumn(row, "id")),
    );
    removed += await this.removeStaleDirectories(
      this.temporaryDirectory,
      this.activeReservations,
      options.removeOrphansImmediately ?? false,
    );
    this.activeReservations.forEach((id) => activeIds.add(id));
    removed += await this.removeStaleDirectories(
      this.filesDirectory,
      activeIds,
      options.removeOrphansImmediately ?? false,
    );

    return { removed };
  }

  private async removeShare(id: string): Promise<void> {
    const database = this.getDatabase();
    database.prepare("DELETE FROM shares WHERE id = ?").run(id);
    await rm(path.join(this.filesDirectory, id), {
      recursive: true,
      force: true,
    }).catch(() => {
      // The database row is authoritative for access. A later orphan cleanup
      // retries the best-effort removal without turning an expired lookup into 500.
    });
  }

  private async removeStaleDirectories(
    parent: string,
    retainedIds: ReadonlySet<string>,
    removeImmediately: boolean,
  ): Promise<number> {
    const entries = await readdir(parent, { withFileTypes: true });
    let removed = 0;

    for (const entry of entries) {
      if (!entry.isDirectory() || retainedIds.has(entry.name)) {
        continue;
      }
      const directory = path.join(parent, entry.name);
      const directoryStat = await stat(directory);
      if (
        !removeImmediately &&
        this.now() - directoryStat.mtimeMs < this.staleReservationMs
      ) {
        continue;
      }
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    }

    return removed;
  }

  private getDatabase(): DatabaseSync {
    if (!this.database) {
      throw new Error("ShareStore must be initialized before use.");
    }
    return this.database;
  }
}

export function createShareCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function createManagementToken(): string {
  return randomBytes(24).toString("base64url");
}

export function sanitizeFileName(input: string): string {
  const leafName = input.split(/[\\/]/).at(-1) ?? "";
  const withoutControls = Array.from(leafName)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("")
    .trim();
  return withoutControls || "file";
}

function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get();
  if (!row || typeof row.user_version !== "number") {
    throw new Error("Could not read the SQLite schema version.");
  }
  return row.user_version;
}

function didChange(result: StatementResultingChanges): boolean {
  return result.changes === 1 || result.changes === 1n;
}

function parseShareRow(value: unknown): ShareRow {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.code !== "string" ||
    typeof value.created_at !== "string" ||
    !isNullableString(value.expires_at) ||
    !isNullableString(value.shared_text) ||
    typeof value.total_bytes !== "number"
  ) {
    throw new Error("SQLite returned an invalid share row.");
  }
  return value as unknown as ShareRow;
}

function parseFileRow(value: unknown): FileRow {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.original_name !== "string" ||
    typeof value.size_bytes !== "number" ||
    typeof value.mime_type !== "string"
  ) {
    throw new Error("SQLite returned an invalid file row.");
  }
  return value as unknown as FileRow;
}

function readStringColumn(value: unknown, column: string): string {
  if (!isRecord(value) || typeof value[column] !== "string") {
    throw new Error(`SQLite returned an invalid ${column} column.`);
  }
  return value[column];
}

function isExpired(expiresAt: string | null, now: number): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= now;
}

function hashManagementToken(token: string): string {
  if (!MANAGEMENT_TOKEN_PATTERN.test(token)) {
    throw new Error("The management token must be 32 URL-safe characters.");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
