import type { Request, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { RateLimit } from '../config/env.js';
import { tooManyRequests } from '../lib/errors.js';

type Options = { skipSuccessfulRequests?: boolean; key?: (req: Request) => string | undefined };

export function createRateLimiter(
  { windowMs, limit }: RateLimit,
  { skipSuccessfulRequests = false, key }: Options = {},
): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests,
    ...(key ? { keyGenerator: (req) => key(req) ?? req.ip ?? 'unknown' } : {}),
    handler: () => {
      throw tooManyRequests();
    },
  });
}

/** Keys login attempts by the (lower-cased) email in the body, so one account cannot be brute-forced from many IPs. */
export function emailKey(req: Request): string | undefined {
  const body = req.body as { email?: unknown } | undefined;
  return typeof body?.email === 'string' ? `acct:${body.email.trim().toLowerCase()}` : undefined;
}
