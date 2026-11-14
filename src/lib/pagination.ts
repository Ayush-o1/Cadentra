import { z } from 'zod';
import { badRequest } from './errors.js';

export const pageQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type Page<T> = { items: T[]; nextCursor: string | null };

export function encodeCursor(id: number): string {
  return Buffer.from(String(id)).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const id = Number(Buffer.from(cursor, 'base64url').toString());
  if (!Number.isSafeInteger(id) || id < 1) throw badRequest('Invalid cursor', 'INVALID_CURSOR');
  return id;
}

/** Turns a query that fetched `limit + 1` rows (newest first) into a page with a cursor. */
export function toPage<T extends { id: number }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.id) : null };
}

export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}
