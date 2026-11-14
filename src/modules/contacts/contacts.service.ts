import type { Contact } from '../../generated/prisma/client.js';
import type { Db, Tx } from '../../lib/db.js';
import { isUniqueViolation } from '../../lib/db.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { recordActivity } from '../activity/activity.service.js';
import { findContactsPage } from './contacts.repository.js';
import type {
  CreateContactInput,
  ListContactsQuery,
  UpdateContactInput,
} from './contacts.schemas.js';

export type ContactView = {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  consentBasis: string;
  consentSource: string | null;
  consentedAt: Date;
  createdAt: Date;
  suppressionReason: string | null;
  lists: { id: number; name: string }[];
};

function toView(
  contact: Pick<
    Contact,
    | 'id'
    | 'email'
    | 'firstName'
    | 'lastName'
    | 'company'
    | 'consentBasis'
    | 'consentSource'
    | 'consentedAt'
    | 'createdAt'
  >,
  suppressionReason: string | null,
  lists: { id: number; name: string }[],
): ContactView {
  return { ...contact, suppressionReason, lists };
}

export type ContactsService = ReturnType<typeof createContactsService>;

export function createContactsService(db: Db) {
  async function listsFor(contactIds: number[]) {
    const links = await db.contactListMember.findMany({
      where: { contactId: { in: contactIds } },
      include: { list: { select: { id: true, name: true } } },
      orderBy: { addedAt: 'asc' },
    });
    const byContact = new Map<number, { id: number; name: string }[]>();
    for (const link of links) {
      byContact.set(link.contactId, [...(byContact.get(link.contactId) ?? []), link.list]);
    }
    return byContact;
  }

  async function assertListsExist(client: Db | Tx, workspaceId: number, listIds: number[]) {
    const unique = [...new Set(listIds)];
    const found = await client.contactList.count({ where: { workspaceId, id: { in: unique } } });
    if (found !== unique.length) {
      throw validationFailed('One of the selected lists does not exist', [
        { path: 'listIds', message: 'One of the selected lists does not exist' },
      ]);
    }
  }

  async function view(workspaceId: number, id: number): Promise<ContactView> {
    const contact = await db.contact.findFirst({ where: { id, workspaceId } });
    if (!contact) throw notFound('Contact');
    const [suppression, lists] = await Promise.all([
      db.suppression.findUnique({
        where: { workspaceId_email: { workspaceId, email: contact.email } },
      }),
      listsFor([contact.id]),
    ]);
    return toView(contact, suppression?.reason ?? null, lists.get(contact.id) ?? []);
  }

  return {
    view,

    async list(workspaceId: number, query: ListContactsQuery) {
      const rows = await findContactsPage(db, workspaceId, query, decodeCursor(query.cursor));
      const pageRows = rows.slice(0, query.limit);
      const lists = await listsFor(pageRows.map((row) => row.id));
      const items: ContactView[] = pageRows.map((row) => ({
        id: row.id,
        email: row.email,
        firstName: row.first_name,
        lastName: row.last_name,
        company: row.company,
        consentBasis: row.consent_basis,
        consentSource: row.consent_source,
        consentedAt: row.consented_at,
        createdAt: row.created_at,
        suppressionReason: row.suppression_reason,
        lists: lists.get(row.id) ?? [],
      }));
      const last = pageRows.at(-1);
      return {
        items,
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.id) : null,
      };
    },

    async create(workspaceId: number, userId: number, input: CreateContactInput) {
      const { listIds, ...fields } = input;
      try {
        const contactId = await db.$transaction(async (tx) => {
          if (listIds?.length) await assertListsExist(tx, workspaceId, listIds);
          const contact = await tx.contact.create({
            data: {
              workspaceId,
              email: fields.email,
              firstName: fields.firstName ?? null,
              lastName: fields.lastName ?? null,
              company: fields.company ?? null,
              consentBasis: fields.consentBasis,
              consentSource: fields.consentSource ?? null,
              consentedAt: fields.consentedAt ?? new Date(),
            },
          });
          if (listIds?.length) {
            await tx.contactListMember.createMany({
              data: [...new Set(listIds)].map((listId) => ({
                workspaceId,
                listId,
                contactId: contact.id,
              })),
            });
          }
          await recordActivity(tx, {
            workspaceId,
            userId,
            action: 'contact.created',
            entityType: 'contact',
            entityId: contact.id,
          });
          return contact.id;
        });
        return await view(workspaceId, contactId);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict('A contact with this email already exists', 'CONTACT_EXISTS');
        }
        throw error;
      }
    },

    async update(workspaceId: number, userId: number, id: number, input: UpdateContactInput) {
      const existing = await db.contact.findFirst({ where: { id, workspaceId } });
      if (!existing) throw notFound('Contact');
      try {
        await db.contact.update({
          where: { id },
          data: {
            ...(input.email !== undefined ? { email: input.email } : {}),
            ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
            ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
            ...(input.company !== undefined ? { company: input.company } : {}),
            ...(input.consentBasis !== undefined ? { consentBasis: input.consentBasis } : {}),
            ...(input.consentSource !== undefined ? { consentSource: input.consentSource } : {}),
            ...(input.consentedAt !== undefined ? { consentedAt: input.consentedAt } : {}),
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict('A contact with this email already exists', 'CONTACT_EXISTS');
        }
        throw error;
      }
      await recordActivity(db, {
        workspaceId,
        userId,
        action: 'contact.updated',
        entityType: 'contact',
        entityId: id,
      });
      return view(workspaceId, id);
    },

    /**
     * Erases the contact together with its list memberships and campaign history.
     * The suppression entry is deliberately kept so an opt-out survives deletion.
     */
    async remove(workspaceId: number, userId: number, id: number): Promise<void> {
      const { count } = await db.contact.deleteMany({ where: { id, workspaceId } });
      if (count === 0) throw notFound('Contact');
      await recordActivity(db, {
        workspaceId,
        userId,
        action: 'contact.deleted',
        entityType: 'contact',
        entityId: id,
      });
    },
  };
}
