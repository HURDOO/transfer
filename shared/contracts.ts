export const EXPIRATION_VALUES = [
  "1h",
  "1d",
  "3d",
  "7d",
  "30d",
  "never",
] as const;

export type ExpirationValue = (typeof EXPIRATION_VALUES)[number];

export const EXPIRATION_MILLISECONDS: Record<
  Exclude<ExpirationValue, "never">,
  number
> = {
  "1h": 60 * 60 * 1_000,
  "1d": 24 * 60 * 60 * 1_000,
  "3d": 3 * 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
};

export const MAX_SHARE_BYTES = 1024 * 1024 * 1024;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_FILES = 50;
export const MAX_FILE_NAME_BYTES = 512;
export const LIVE_SESSION_TTL_MS = 10 * 60 * 1_000;

export interface ShareFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  downloadUrl: string;
}

export interface ShareResponse {
  code: string;
  shareUrl: string;
  createdAt: string;
  expiresAt: string | null;
  text: string | null;
  totalBytes: number;
  files: ShareFile[];
}

export interface CreateShareResponse extends ShareResponse {
  managementToken: string;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export type ReceiveCodeKind = "stored" | "live";

export interface ResolveCodeResponse {
  code: string;
  kind: ReceiveCodeKind;
}

export type LiveDescriptionType = "offer" | "answer";

export interface LiveSessionDescription {
  type: LiveDescriptionType;
  sdp: string;
}

export interface LiveIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

export type LiveClientSignal =
  | {
      type: "description";
      description: LiveSessionDescription;
    }
  | {
      type: "candidate";
      candidate: LiveIceCandidate;
    };

export type LiveSignal = LiveClientSignal | { type: "peer-ready" };

export interface LiveSignalMessage {
  sequence: number;
  signal: LiveSignal;
}

export interface LiveIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface CreateLiveSessionResponse {
  code: string;
  liveUrl: string;
  expiresAt: string;
  senderToken: string;
  iceServers: LiveIceServer[];
}

export interface JoinLiveSessionResponse {
  code: string;
  expiresAt: string;
  receiverToken: string;
  iceServers: LiveIceServer[];
}

export interface PollLiveSignalsResponse {
  expiresAt: string;
  messages: LiveSignalMessage[];
}

export function isExpirationValue(value: string): value is ExpirationValue {
  return EXPIRATION_VALUES.includes(value as ExpirationValue);
}
