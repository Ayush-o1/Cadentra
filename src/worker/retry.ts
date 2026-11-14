export const MAX_ATTEMPTS = 5;

/** Wait before attempt 2, 3, 4 and 5. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

export type RetryDecision = { kind: 'retry'; runAt: Date } | { kind: 'fail' };

/**
 * Decides what happens after a failed attempt. `attempts` counts the attempt that just failed.
 * A permanent error, or running out of attempts, ends the message. Otherwise it is rescheduled
 * with growing delays, honouring a longer wait requested by the provider (for example on a 429).
 */
export function decideRetry(input: {
  retryable: boolean;
  attempts: number;
  retryAfterMs?: number | undefined;
  now: Date;
}): RetryDecision {
  const { retryable, attempts, retryAfterMs, now } = input;
  if (!retryable || attempts >= MAX_ATTEMPTS) return { kind: 'fail' };
  const backoff = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] ?? BACKOFF_MS.at(-1)!;
  return { kind: 'retry', runAt: new Date(now.getTime() + Math.max(backoff, retryAfterMs ?? 0)) };
}
