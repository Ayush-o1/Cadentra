import type { Request, Response } from 'express';
import { notFound } from './errors.js';

export function parseId(value: unknown, what = 'Resource'): number {
  const id = typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) throw notFound(what);
  return id;
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

export function noContent(res: Response): void {
  res.status(204).end();
}
