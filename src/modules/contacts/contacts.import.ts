import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { notFound, validationFailed } from '../../lib/errors.js';
import { emailSchema } from '../../lib/schemas.js';
import { recordActivity } from '../activity/activity.service.js';

export const MAX_IMPORT_ROWS = 5000;
const BATCH_SIZE = 500;
const MAX_REPORTED_ERRORS = 100;

const COLUMN_ALIASES: Record<string, string> = {
  email: 'email',
  email_address: 'email',
  first_name: 'firstName',
  firstname: 'firstName',
  first: 'firstName',
  last_name: 'lastName',
  lastname: 'lastName',
  last: 'lastName',
  company: 'company',
  company_name: 'company',
  organization: 'company',
  organisation: 'company',
};

const rowSchema = z.object({
  email: emailSchema,
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  company: z.string().trim().max(160).optional(),
});

type ParsedRecord = { record: Record<string, string>; info: { lines: number } };
type ValidRow = {
  line: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
};

export type ImportRowError = { row: number; email: string | null; message: string };

export type ImportReport = {
  totalRows: number;
  created: number;
  duplicates: number;
  invalid: number;
  suppressed: number;
  addedToList: number;
  errors: ImportRowError[];
  errorsTruncated: boolean;
};

export type ImportOptions = {
  consentBasis:
    'requested_contact' | 'existing_customer' | 'signed_up' | 'event_attendee' | 'other_documented';
  source: string | undefined;
  listId: number | undefined;
};

function normalizeHeader(header: string): string {
  const key = header
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return COLUMN_ALIASES[key] ?? key;
}

function parseCsv(text: string): ParsedRecord[] {
  try {
    const records: ParsedRecord[] = parse(text, {
      columns: (header: string[]) => header.map(normalizeHeader),
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      info: true,
    });
    return records;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The file could not be read';
    throw validationFailed(`The CSV file is malformed: ${reason}`);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export async function importContacts(
  db: Db,
  workspaceId: number,
  userId: number,
  csvText: string,
  options: ImportOptions,
): Promise<ImportReport> {
  if (options.listId !== undefined) {
    const list = await db.contactList.findFirst({ where: { id: options.listId, workspaceId } });
    if (!list) throw notFound('List');
  }

  const records = parseCsv(csvText);
  if (records.length === 0) throw validationFailed('The file has no rows to import');
  if (!('email' in records[0]!.record)) {
    throw validationFailed('The file needs a header row with an "email" column');
  }
  if (records.length > MAX_IMPORT_ROWS) {
    throw validationFailed(`Import at most ${MAX_IMPORT_ROWS} rows at a time`);
  }

  const errors: ImportRowError[] = [];
  const valid: ValidRow[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let invalid = 0;

  for (const { record, info } of records) {
    const parsed = rowSchema.safeParse({
      email: record['email'] ?? '',
      firstName: record['firstName'] || undefined,
      lastName: record['lastName'] || undefined,
      company: record['company'] || undefined,
    });
    if (!parsed.success) {
      invalid += 1;
      errors.push({
        row: info.lines,
        email: record['email'] || null,
        message: parsed.error.issues[0]?.message ?? 'Invalid row',
      });
      continue;
    }
    const row = parsed.data;
    if (seen.has(row.email)) {
      duplicates += 1;
      errors.push({ row: info.lines, email: row.email, message: 'Appears earlier in the file' });
      continue;
    }
    seen.add(row.email);
    valid.push({
      line: info.lines,
      email: row.email,
      firstName: row.firstName ?? null,
      lastName: row.lastName ?? null,
      company: row.company ?? null,
    });
  }

  let created = 0;
  let suppressed = 0;
  let addedToList = 0;
  const consentedAt = new Date();
  const consentSource = options.source ?? 'CSV import';

  for (const batch of chunk(valid, BATCH_SIZE)) {
    const emails = batch.map((row) => row.email);
    const existing = await db.contact.findMany({
      where: { workspaceId, email: { in: emails } },
      select: { email: true },
    });
    const existingEmails = new Set(existing.map((contact) => contact.email));
    for (const row of batch) {
      if (existingEmails.has(row.email)) {
        duplicates += 1;
        errors.push({
          row: row.line,
          email: row.email,
          message: 'A contact with this email already exists',
        });
      }
    }
    const fresh = batch.filter((row) => !existingEmails.has(row.email));

    await db.$transaction(async (tx) => {
      const result = await tx.contact.createMany({
        data: fresh.map((row) => ({
          workspaceId,
          email: row.email,
          firstName: row.firstName,
          lastName: row.lastName,
          company: row.company,
          consentBasis: options.consentBasis,
          consentSource,
          consentedAt,
        })),
        skipDuplicates: true,
      });
      created += result.count;

      if (options.listId !== undefined) {
        const members = await tx.contact.findMany({
          where: { workspaceId, email: { in: emails } },
          select: { id: true },
        });
        const added = await tx.contactListMember.createMany({
          data: members.map((member) => ({
            workspaceId,
            listId: options.listId!,
            contactId: member.id,
          })),
          skipDuplicates: true,
        });
        addedToList += added.count;
      }
    });

    suppressed += await db.suppression.count({ where: { workspaceId, email: { in: emails } } });
  }

  errors.sort((a, b) => a.row - b.row);
  await recordActivity(db, {
    workspaceId,
    userId,
    action: 'contacts.imported',
    metadata: { totalRows: records.length, created, duplicates, invalid },
  });

  return {
    totalRows: records.length,
    created,
    duplicates,
    invalid,
    suppressed,
    addedToList,
    errors: errors.slice(0, MAX_REPORTED_ERRORS),
    errorsTruncated: errors.length > MAX_REPORTED_ERRORS,
  };
}
