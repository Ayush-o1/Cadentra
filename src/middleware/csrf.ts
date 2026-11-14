import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_BODY_TYPES = ['application/json', 'text/csv'];

const csrfRejected = () => new AppError(403, 'CSRF_REJECTED', 'Cross-site request rejected');

/**
 * Defence in depth on top of SameSite=Lax session cookies. Browsers always attach Origin
 * (or Sec-Fetch-Site) to cross-site writes, so a forged request cannot pass the checks below.
 * Writes that carry a body must also be JSON or CSV, which an HTML form cannot send.
 */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const origin = req.get('origin');
  if (origin) {
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw csrfRejected();
    }
    if (originHost !== req.get('host')) throw csrfRejected();
  } else {
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') throw csrfRejected();
  }

  const hasBody = Number(req.get('content-length') ?? 0) > 0 || req.get('transfer-encoding');
  if (hasBody && !ALLOWED_BODY_TYPES.some((type) => req.is(type))) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the request body as JSON');
  }
  next();
};
