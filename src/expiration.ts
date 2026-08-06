export const MAX_EXPIRATION_TIMER_DELAY_MS = 24 * 60 * 60 * 1_000;

export function hasExpirationPassed(
  expiresAt: string | null,
  now = Date.now(),
): boolean {
  if (expiresAt === null) return false;
  const expirationTime = Date.parse(expiresAt);
  return !Number.isFinite(expirationTime) || expirationTime <= now;
}

export function getNextExpirationDelay(
  expiresAt: string,
  now = Date.now(),
): number {
  const expirationTime = Date.parse(expiresAt);
  if (!Number.isFinite(expirationTime)) return 0;
  return Math.max(
    0,
    Math.min(expirationTime - now, MAX_EXPIRATION_TIMER_DELAY_MS),
  );
}
