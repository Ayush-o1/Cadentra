import { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { escapeLike } from '../../lib/pagination.js';
import type { ListContactsQuery } from './contacts.schemas.js';

export type ContactRow = {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  consent_basis: string;
  consent_source: string | null;
  consented_at: Date;
  created_at: Date;
  suppression_reason: string | null;
};

/**
 * Contacts are joined to the suppression list by address, so the list can be filtered
 * by suppression status in one indexed query. Both joins use the (workspace_id, ...) unique keys.
 */
export async function findContactsPage(
  db: Db,
  workspaceId: number,
  query: ListContactsQuery,
  before: number | undefined,
): Promise<ContactRow[]> {
  const conditions: Prisma.Sql[] = [Prisma.sql`c.workspace_id = ${workspaceId}`];

  if (before !== undefined) conditions.push(Prisma.sql`c.id < ${before}`);

  if (query.search) {
    const escaped = escapeLike(query.search);
    conditions.push(Prisma.sql`(
      c.email LIKE ${`${escaped}%`}
      OR CONCAT_WS(' ', c.first_name, c.last_name) LIKE ${`%${escaped}%`}
      OR c.company LIKE ${`%${escaped}%`}
    )`);
  }
  if (query.listId !== undefined) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM contact_list_members m
      WHERE m.list_id = ${query.listId} AND m.contact_id = c.id AND m.workspace_id = c.workspace_id
    )`);
  }
  if (query.status === 'suppressed') conditions.push(Prisma.sql`s.id IS NOT NULL`);
  if (query.status === 'active') conditions.push(Prisma.sql`s.id IS NULL`);

  return db.$queryRaw<ContactRow[]>`
    SELECT c.id, c.email, c.first_name, c.last_name, c.company, c.consent_basis,
           c.consent_source, c.consented_at, c.created_at, s.reason AS suppression_reason
    FROM contacts c
    LEFT JOIN suppressions s ON s.workspace_id = c.workspace_id AND s.email = c.email
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY c.id DESC
    LIMIT ${query.limit + 1}`;
}
