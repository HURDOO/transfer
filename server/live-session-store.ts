import { randomBytes, randomInt } from "node:crypto";

import {
  LIVE_SESSION_TTL_MS,
  type LiveClientSignal,
  type LiveSignalMessage,
} from "../shared/contracts.js";

const CODE_SPACE = 1_000_000;
const MAX_CODE_ATTEMPTS = 64;
const MAX_SESSIONS = 1_000;
const MAX_MESSAGES_PER_PEER = 256;

export type LivePeerRole = "sender" | "receiver";

export interface LiveSessionCredentials {
  code: string;
  senderToken: string;
  expiresAt: string;
}

export interface JoinedLiveSession {
  code: string;
  receiverToken: string;
  expiresAt: string;
}

export type JoinLiveSessionResult =
  | { status: "joined"; session: JoinedLiveSession }
  | { status: "not-found" }
  | { status: "occupied" };

export type LiveSessionActionResult =
  { status: "ok" } | { status: "not-found" };

export type PollLiveSessionResult =
  | {
      status: "ok";
      expiresAt: string;
      messages: LiveSignalMessage[];
    }
  | { status: "not-found" };

interface LiveSession {
  code: string;
  senderToken: string;
  receiverToken: string | null;
  expiresAtMs: number;
  nextSequence: number;
  senderMessages: LiveSignalMessage[];
  receiverMessages: LiveSignalMessage[];
}

interface LiveSessionStoreOptions {
  now?: () => number;
  createCode?: () => string;
  createToken?: () => string;
  ttlMs?: number;
  maxSessions?: number;
  isCodeUnavailable?: (code: string) => boolean;
}

export class LiveSessionStore {
  readonly #sessions = new Map<string, LiveSession>();
  readonly #now: () => number;
  readonly #createCode: () => string;
  readonly #createToken: () => string;
  readonly #ttlMs: number;
  readonly #maxSessions: number;
  readonly #isCodeUnavailable: (code: string) => boolean;

  constructor(options: LiveSessionStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#createCode = options.createCode ?? createSixDigitCode;
    this.#createToken = options.createToken ?? createPeerToken;
    this.#ttlMs = options.ttlMs ?? LIVE_SESSION_TTL_MS;
    this.#maxSessions = options.maxSessions ?? MAX_SESSIONS;
    this.#isCodeUnavailable = options.isCodeUnavailable ?? (() => false);

    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) {
      throw new Error("ttlMs must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(this.#maxSessions) || this.#maxSessions < 1) {
      throw new Error("maxSessions must be a positive safe integer.");
    }
  }

  create(): LiveSessionCredentials | null {
    this.cleanup();
    if (this.#sessions.size >= this.#maxSessions) {
      return null;
    }

    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const code = this.#createCode();
      if (!/^\d{6}$/.test(code)) {
        throw new Error("createCode must return exactly six digits.");
      }
      if (this.#sessions.has(code) || this.#isCodeUnavailable(code)) {
        continue;
      }

      const expiresAtMs = this.#now() + this.#ttlMs;
      const session: LiveSession = {
        code,
        senderToken: this.#createToken(),
        receiverToken: null,
        expiresAtMs,
        nextSequence: 1,
        senderMessages: [],
        receiverMessages: [],
      };
      this.#sessions.set(code, session);
      return {
        code,
        senderToken: session.senderToken,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    }

    return null;
  }

  join(code: string): JoinLiveSessionResult {
    const session = this.#getActive(code);
    if (!session) {
      return { status: "not-found" };
    }
    if (session.receiverToken !== null) {
      return { status: "occupied" };
    }

    session.receiverToken = this.#createToken();
    this.#enqueue(session, "sender", { type: "peer-ready" });
    return {
      status: "joined",
      session: {
        code,
        receiverToken: session.receiverToken,
        expiresAt: new Date(session.expiresAtMs).toISOString(),
      },
    };
  }

  hasActiveCode(code: string): boolean {
    return this.#getActive(code) !== undefined;
  }

  postSignal(
    code: string,
    token: string,
    signal: LiveClientSignal,
  ): LiveSessionActionResult {
    const session = this.#getActive(code);
    const role = session ? this.#getRole(session, token) : null;
    if (!session || !role || session.receiverToken === null) {
      return { status: "not-found" };
    }

    this.#enqueue(session, role === "sender" ? "receiver" : "sender", signal);
    return { status: "ok" };
  }

  poll(code: string, token: string, after: number): PollLiveSessionResult {
    const session = this.#getActive(code);
    const role = session ? this.#getRole(session, token) : null;
    if (!session || !role) {
      return { status: "not-found" };
    }

    const messages = (
      role === "sender" ? session.senderMessages : session.receiverMessages
    ).filter((message) => message.sequence > after);
    return {
      status: "ok",
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      messages,
    };
  }

  close(code: string, token: string): LiveSessionActionResult {
    const session = this.#getActive(code);
    if (!session || !this.#getRole(session, token)) {
      return { status: "not-found" };
    }
    this.#sessions.delete(code);
    return { status: "ok" };
  }

  cleanup(): number {
    const now = this.#now();
    let removed = 0;
    for (const [code, session] of this.#sessions) {
      if (session.expiresAtMs <= now) {
        this.#sessions.delete(code);
        removed += 1;
      }
    }
    return removed;
  }

  #getActive(code: string): LiveSession | undefined {
    const session = this.#sessions.get(code);
    if (!session) {
      return undefined;
    }
    if (session.expiresAtMs <= this.#now()) {
      this.#sessions.delete(code);
      return undefined;
    }
    return session;
  }

  #getRole(session: LiveSession, token: string): LivePeerRole | null {
    if (token === session.senderToken) {
      return "sender";
    }
    if (token === session.receiverToken) {
      return "receiver";
    }
    return null;
  }

  #enqueue(
    session: LiveSession,
    target: LivePeerRole,
    signal: LiveSignalMessage["signal"],
  ): void {
    const messages =
      target === "sender" ? session.senderMessages : session.receiverMessages;
    messages.push({ sequence: session.nextSequence, signal });
    session.nextSequence += 1;
    if (messages.length > MAX_MESSAGES_PER_PEER) {
      messages.splice(0, messages.length - MAX_MESSAGES_PER_PEER);
    }
  }
}

function createSixDigitCode(): string {
  return randomInt(0, CODE_SPACE).toString().padStart(6, "0");
}

function createPeerToken(): string {
  return randomBytes(24).toString("base64url");
}
