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

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export function isExpirationValue(value: string): value is ExpirationValue {
  return EXPIRATION_VALUES.includes(value as ExpirationValue);
}
