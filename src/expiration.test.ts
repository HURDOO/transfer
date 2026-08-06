import { describe, expect, it } from "vitest";

import {
  MAX_EXPIRATION_TIMER_DELAY_MS,
  getNextExpirationDelay,
  hasExpirationPassed,
} from "./expiration";

describe("share expiration timing", () => {
  const now = Date.UTC(2026, 7, 7, 0, 0, 0);

  it("treats the expiration boundary as unavailable", () => {
    expect(hasExpirationPassed(null, now)).toBe(false);
    expect(hasExpirationPassed(new Date(now + 1).toISOString(), now)).toBe(
      false,
    );
    expect(hasExpirationPassed(new Date(now).toISOString(), now)).toBe(true);
    expect(hasExpirationPassed(new Date(now - 1).toISOString(), now)).toBe(
      true,
    );
    expect(hasExpirationPassed("invalid", now)).toBe(true);
  });

  it("caps long browser timers and reaches zero at expiration", () => {
    expect(getNextExpirationDelay(new Date(now).toISOString(), now)).toBe(0);
    expect(
      getNextExpirationDelay(new Date(now + 5_000).toISOString(), now),
    ).toBe(5_000);
    expect(
      getNextExpirationDelay(
        new Date(now + MAX_EXPIRATION_TIMER_DELAY_MS * 2).toISOString(),
        now,
      ),
    ).toBe(MAX_EXPIRATION_TIMER_DELAY_MS);
  });
});
