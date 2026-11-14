import { describe, expect, it } from 'vitest';
import { decideRetry, MAX_ATTEMPTS } from '../../src/worker/retry.js';

const now = new Date('2026-11-17T10:00:00Z');
const minutes = (count: number) => new Date(now.getTime() + count * 60_000);

describe('decideRetry', () => {
  it('fails immediately on a permanent error, whatever the attempt number', () => {
    for (const attempts of [1, 2, 4]) {
      expect(decideRetry({ retryable: false, attempts, now })).toEqual({ kind: 'fail' });
    }
  });

  it('backs off more each time for transient errors', () => {
    const delays = [1, 2, 3, 4].map((attempts) => {
      const decision = decideRetry({ retryable: true, attempts, now });
      if (decision.kind !== 'retry') throw new Error('expected a retry');
      return (decision.runAt.getTime() - now.getTime()) / 60_000;
    });
    expect(delays).toEqual([1, 5, 30, 120]);
  });

  it('gives up once the attempts are used up', () => {
    expect(decideRetry({ retryable: true, attempts: MAX_ATTEMPTS, now })).toEqual({ kind: 'fail' });
    expect(decideRetry({ retryable: true, attempts: MAX_ATTEMPTS + 3, now })).toEqual({
      kind: 'fail',
    });
  });

  it('waits at least as long as the provider asks', () => {
    expect(decideRetry({ retryable: true, attempts: 1, retryAfterMs: 10 * 60_000, now })).toEqual({
      kind: 'retry',
      runAt: minutes(10),
    });
    expect(decideRetry({ retryable: true, attempts: 3, retryAfterMs: 1000, now })).toEqual({
      kind: 'retry',
      runAt: minutes(30),
    });
  });
});
