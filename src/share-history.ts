import type { CreateShareResponse } from "../shared/contracts";

const DATABASE_NAME = "move-it";
const DATABASE_VERSION = 1;
const STORE_NAME = "sent-transfers";

export type SentTransferKind = "stored" | "live";
export type SentTransferStatus = "active" | "completed" | "expired" | "deleted";

export interface SentTransferRecord {
  id: string;
  kind: SentTransferKind;
  status: SentTransferStatus;
  createdAt: string;
  expiresAt: string | null;
  code: string | null;
  managementToken: string | null;
  fileNames: string[];
  textIncluded: boolean;
  totalBytes: number;
}

let databasePromise: Promise<IDBDatabase> | null = null;

export function createStoredTransferRecord(
  share: CreateShareResponse,
): SentTransferRecord {
  return {
    id: `stored:${share.createdAt}:${share.code}`,
    kind: "stored",
    status: "active",
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    code: share.code,
    managementToken: share.managementToken,
    fileNames: share.files.map((file) => file.name),
    textIncluded: share.text !== null,
    totalBytes: share.totalBytes,
  };
}

export function createLiveTransferRecord(input: {
  createdAt: string;
  fileNames: string[];
  textIncluded: boolean;
  totalBytes: number;
}): SentTransferRecord {
  return {
    id: `live:${input.createdAt}:${crypto.randomUUID()}`,
    kind: "live",
    status: "completed",
    createdAt: input.createdAt,
    expiresAt: null,
    code: null,
    managementToken: null,
    fileNames: [...input.fileNames],
    textIncluded: input.textIncluded,
    totalBytes: input.totalBytes,
  };
}

export function reconcileTransferExpiration(
  record: SentTransferRecord,
  now = Date.now(),
): SentTransferRecord {
  if (
    record.kind !== "stored" ||
    record.status !== "active" ||
    record.expiresAt === null ||
    Date.parse(record.expiresAt) > now
  ) {
    return record;
  }
  return {
    ...record,
    status: "expired",
    code: null,
    managementToken: null,
  };
}

export async function saveSentTransfer(
  record: SentTransferRecord,
): Promise<void> {
  const database = await openDatabase();
  await runTransaction(database, "readwrite", (store) => store.put(record));
}

export async function listSentTransfers(): Promise<SentTransferRecord[]> {
  const database = await openDatabase();
  const records = await runTransaction<unknown[]>(
    database,
    "readonly",
    (store) => store.getAll(),
  );
  return records
    .filter(isSentTransferRecord)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function removeSentTransferRecord(id: string): Promise<void> {
  const database = await openDatabase();
  await runTransaction(database, "readwrite", (store) => store.delete(id));
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("기록장을 열지 못했어요."));
    request.onblocked = () =>
      reject(new Error("다른 탭에서 기록장을 사용 중이에요."));
  }).catch((error: unknown) => {
    databasePromise = null;
    throw error;
  });
  databasePromise = opening;
  return opening;
}

function runTransaction<T = undefined>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () =>
      reject(
        transaction.error ??
          request.error ??
          new Error("기록을 저장하지 못했어요."),
      );
    transaction.onabort = () =>
      reject(
        transaction.error ??
          request.error ??
          new Error("기록 저장이 취소됐어요."),
      );
  });
}

function isSentTransferRecord(value: unknown): value is SentTransferRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    (record.kind === "stored" || record.kind === "live") &&
    ["active", "completed", "expired", "deleted"].includes(
      String(record.status),
    ) &&
    typeof record.createdAt === "string" &&
    (record.expiresAt === null || typeof record.expiresAt === "string") &&
    (record.code === null || typeof record.code === "string") &&
    (record.managementToken === null ||
      typeof record.managementToken === "string") &&
    Array.isArray(record.fileNames) &&
    record.fileNames.every((name) => typeof name === "string") &&
    typeof record.textIncluded === "boolean" &&
    typeof record.totalBytes === "number"
  );
}
