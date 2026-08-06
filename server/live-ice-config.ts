import type { LiveIceServer } from "../shared/contracts.js";

const ICE_URL_PATTERN = /^(?:stun|stuns|turn|turns):/i;

export function parseLiveIceServers(
  rawValue: string | undefined,
): LiveIceServer[] {
  if (!rawValue || rawValue.trim().length === 0) {
    return [];
  }

  let value: unknown;
  try {
    value = JSON.parse(rawValue) as unknown;
  } catch {
    throw new Error("LIVE_ICE_SERVERS must be valid JSON.");
  }
  if (!Array.isArray(value) || value.length > 10) {
    throw new Error("LIVE_ICE_SERVERS must be an array with up to 10 entries.");
  }

  return value.map((entry) => parseIceServer(entry));
}

function parseIceServer(value: unknown): LiveIceServer {
  if (!isRecord(value)) {
    throw new Error("Each LIVE_ICE_SERVERS entry must be an object.");
  }
  const urls = parseIceUrls(value.urls);
  const username = parseOptionalString(value.username, "username");
  const credential = parseOptionalString(value.credential, "credential");
  if ((username === undefined) !== (credential === undefined)) {
    throw new Error(
      "TURN username and credential must be configured together.",
    );
  }
  return {
    urls,
    ...(username === undefined ? {} : { username, credential }),
  };
}

function parseIceUrls(value: unknown): string | string[] {
  if (typeof value === "string") {
    return ensureIceUrl(value);
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 10 ||
    !value.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error("ICE urls must be a string or a non-empty string array.");
  }
  return value.map(ensureIceUrl);
}

function ensureIceUrl(value: string): string {
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    !ICE_URL_PATTERN.test(value)
  ) {
    throw new Error("ICE urls must use stun, stuns, turn, or turns.");
  }
  return value;
}

function parseOptionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
    throw new Error(`ICE ${field} must be a non-empty string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
