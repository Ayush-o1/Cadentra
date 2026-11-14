import type { SuppressionReason } from '../../generated/prisma/client.js';
import type { Db, Tx } from '../../lib/db.js';
import { conflict, notFound } from '../../lib/errors.js';
import { escapeLike, decodeCursor, toPage, type Page } from '../../lib/pagination.js';
import { recordActivity } from '../activity/activity.service.js';

type SuppressInput = {
  workspaceId: number;
  email: string;
  reason: SuppressionReason;
  sourceMessageId?: number;
};

/**
 * Adds an address to the suppression list and stops every pending send to it.
 * Safe to call repeatedly: an address that is already suppressed keeps its original reason.
 * Runs inside the caller's transaction so an opt-out is applied completely or not at all.
 */
export async function suppressEmail(tx: Tx, input: SuppressInput): Promise<boolean> {
  const { workspaceId, email, reason, sourceMessageId } = input;
  const created = await tx.suppression.createMany({
    data: [{ workspaceId, email, reason, sourceMessageId: sourceMessageId ?? null }],
    skipDuplicates: true,
  });

  const contact = await tx.contact.findUnique({
    where: { workspaceId_email: { workspaceId, email } },
    select: { id: true },
  });
  if (contact) {
    const recipients = await tx.campaignRecipient.findMany({
      where: { workspaceId, contactId: contact.id, status: 'active' },
      select: { id: true },
    });
    const recipientIds = recipients.map((recipient) => recipient.id);
    if (recipientIds.length > 0) {
      await tx.emailMessage.updateMany({
        where: { recipientId: { in: recipientIds }, status: 'scheduled' },
        data: { status: 'skipped', lastError: 'Recipient is suppressed' },
      });
      await tx.campaignRecipient.updateMany({
        where: { id: { in: recipientIds } },
        data: { status: 'stopped', stopReason: reason },
      });
    }
  }
  return created.count > 0;
}

export function createSuppressionService(db: Db) {
  return {
    async list(
      workspaceId: number,
      query: { search?: string | undefined; cursor?: string | undefined; limit: number },
    ): Promise<Page<{ id: number; email: string; reason: SuppressionReason; createdAt: Date }>> {
      const before = decodeCursor(query.cursor);
      const rows = await db.suppression.findMany({
        where: {
          workspaceId,
          ...(before ? { id: { lt: before } } : {}),
          ...(query.search ? { email: { contains: escapeLike(query.search) } } : {}),
        },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        select: { id: true, email: true, reason: true, createdAt: true },
      });
      return toPage(rows, query.limit);
    },

    async addManual(workspaceId: number, userId: number, email: string) {
      await db.$transaction(async (tx) => {
        const added = await suppressEmail(tx, { workspaceId, email, reason: 'manual' });
        if (added) {
          await recordActivity(tx, {
            workspaceId,
            userId,
            action: 'suppression.added',
            entityType: 'suppression',
            metadata: { email, reason: 'manual' },
          });
        }
      });
      return db.suppression.findUniqueOrThrow({
        where: { workspaceId_email: { workspaceId, email } },
      });
    },

    /** Only manual entries can be lifted. Unsubscribes, bounces and complaints are permanent. */
    async remove(workspaceId: number, userId: number, id: number): Promise<void> {
      const entry = await db.suppression.findFirst({ where: { id, workspaceId } });
      if (!entry) throw notFound('Suppression');
      if (entry.reason !== 'manual') {
        throw conflict(
          'Unsubscribes, bounces and complaints cannot be removed from the suppression list',
          'SUPPRESSION_LOCKED',
        );
      }
      await db.suppression.delete({ where: { id } });
      await recordActivity(db, {
        workspaceId,
        userId,
        action: 'suppression.removed',
        entityType: 'suppression',
        entityId: id,
        metadata: { email: entry.email },
      });
    },
  };
}
