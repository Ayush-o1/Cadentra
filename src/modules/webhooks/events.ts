import type { MessageStatus, Prisma } from '../../generated/prisma/client.js';
import type { Db, Tx } from '../../lib/db.js';
import { autoPauseCampaign } from '../campaigns/campaigns.actions.js';
import { suppressEmail } from '../suppression/suppression.service.js';
import { assessCampaignHealth } from '../../worker/health.js';

export type ProviderEvent = {
  provider: 'resend' | 'fake';
  eventId: string;
  type: string;
  providerMessageId: string | null;
  occurredAt: Date;
  payload?: Prisma.InputJsonValue;
};

export type EventOutcome = 'applied' | 'duplicate' | 'unmatched' | 'ignored';

/**
 * Events can arrive late, repeated or out of order, so a message only ever moves forward.
 * `delivered` never overwrites `bounced`, and a late `accepted` never overwrites `delivered`.
 */
const RANK: Record<MessageStatus, number> = {
  scheduled: 0,
  sending: 1,
  accepted: 2,
  delivered: 3,
  bounced: 4,
  complained: 4,
  failed: 4,
  skipped: 5,
  cancelled: 5,
};

export function movesForward(current: MessageStatus, next: MessageStatus): boolean {
  return RANK[next] > RANK[current];
}

type Change = {
  status: MessageStatus;
  suppress?: 'hard_bounce' | 'complaint';
  note?: string;
};

function changeFor(type: string): Change | 'note-only' | null {
  switch (type) {
    case 'email.delivered':
      return { status: 'delivered' };
    case 'email.bounced':
      return {
        status: 'bounced',
        suppress: 'hard_bounce',
        note: 'Bounced: the address does not accept mail',
      };
    case 'email.complained':
      return {
        status: 'complained',
        suppress: 'complaint',
        note: 'Recipient marked the email as spam',
      };
    case 'email.failed':
      return { status: 'failed', note: 'The provider could not send the email' };
    case 'email.suppressed':
      return { status: 'failed', note: 'The provider suppressed this address' };
    case 'email.delivery_delayed':
      return 'note-only';
    default:
      return null;
  }
}

async function applyToMessage(tx: Tx, messageId: number, event: ProviderEvent): Promise<boolean> {
  const change = changeFor(event.type);
  if (change === null) return false;

  const message = await tx.emailMessage.findUnique({ where: { id: messageId } });
  if (!message) return false;

  if (change === 'note-only') {
    if (message.status === 'accepted') {
      await tx.emailMessage.update({
        where: { id: messageId },
        data: { lastError: 'Delivery is delayed; the provider is still trying' },
      });
    }
    return true;
  }
  if (!movesForward(message.status, change.status)) return true;

  await tx.emailMessage.update({
    where: { id: messageId },
    data: {
      status: change.status,
      ...(change.status === 'delivered' ? { deliveredAt: event.occurredAt, lastError: null } : {}),
      ...(change.status !== 'delivered'
        ? { failedAt: event.occurredAt, lastError: change.note ?? null }
        : {}),
    },
  });

  if (change.suppress) {
    await suppressEmail(tx, {
      workspaceId: message.workspaceId,
      email: message.toEmail,
      reason: change.suppress,
      sourceMessageId: message.id,
    });
  } else if (change.status === 'failed') {
    await tx.campaignRecipient.updateMany({
      where: { id: message.recipientId, status: 'active' },
      data: { status: 'stopped', stopReason: 'failed' },
    });
  }
  return true;
}

/** Pauses the campaign if this bounce or complaint pushed its rates over the limit. */
async function reviewCampaignHealth(db: Db, campaignId: number): Promise<void> {
  const [accepted, bounced, complained] = await Promise.all([
    db.emailMessage.count({ where: { campaignId, acceptedAt: { not: null } } }),
    db.emailMessage.count({ where: { campaignId, status: 'bounced' } }),
    db.emailMessage.count({ where: { campaignId, status: 'complained' } }),
  ]);
  const verdict = assessCampaignHealth({ accepted, bounced, complained });
  if (verdict.pause) await autoPauseCampaign(db, campaignId, verdict.reason);
}

/**
 * Stores a provider event exactly once and applies it to its message.
 *
 * The unique (provider, event id) key makes redelivery harmless. An event for a message we cannot
 * find yet, for instance because the webhook beat our own database write, is kept as `unmatched`
 * and applied later by `reconcileUnmatchedEvents`.
 */
export async function recordProviderEvent(db: Db, event: ProviderEvent): Promise<EventOutcome> {
  const inserted = await db.webhookEvent.createMany({
    data: [
      {
        provider: event.provider,
        providerEventId: event.eventId,
        eventType: event.type,
        providerMessageId: event.providerMessageId,
        status: 'unmatched',
        receivedAt: new Date(),
        ...(event.payload === undefined ? {} : { payload: event.payload }),
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count === 0) {
    // A redelivery of an event we stored but could not apply (a database error halfway through,
    // or its message was not known yet) must get another chance, or the provider's retry would
    // be swallowed as a duplicate and the message would stay stale forever. Applying is
    // idempotent: statuses only move forward.
    const existing = await db.webhookEvent.findUnique({
      where: {
        provider_providerEventId: { provider: event.provider, providerEventId: event.eventId },
      },
      select: { status: true },
    });
    if (existing?.status !== 'unmatched') return 'duplicate';
  }
  return applyStoredEvent(db, event);
}

async function applyStoredEvent(db: Db, event: ProviderEvent): Promise<EventOutcome> {
  const key = {
    provider_providerEventId: { provider: event.provider, providerEventId: event.eventId },
  };
  const message = event.providerMessageId
    ? await db.emailMessage.findUnique({
        where: { providerMessageId: event.providerMessageId },
        select: { id: true, campaignId: true },
      })
    : null;
  if (!message) return 'unmatched';

  const understood = await db.$transaction(async (tx) => {
    const handled = await applyToMessage(tx, message.id, event);
    await tx.webhookEvent.update({
      where: key,
      data: { status: handled ? 'processed' : 'ignored', processedAt: new Date() },
    });
    return handled;
  });
  if (understood && (event.type === 'email.bounced' || event.type === 'email.complained')) {
    await reviewCampaignHealth(db, message.campaignId);
  }
  return understood ? 'applied' : 'ignored';
}

/** Applies events that arrived before the message's provider id was saved. */
export async function reconcileUnmatchedEvents(db: Db, providerMessageId: string): Promise<number> {
  const stored = await db.webhookEvent.findMany({
    where: { providerMessageId, status: 'unmatched' },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
  });
  let applied = 0;
  for (const row of stored) {
    const outcome = await applyStoredEvent(db, {
      provider: row.provider as ProviderEvent['provider'],
      eventId: row.providerEventId,
      type: row.eventType,
      providerMessageId: row.providerMessageId,
      occurredAt: row.receivedAt,
    });
    if (outcome === 'applied' || outcome === 'ignored') applied += 1;
  }
  return applied;
}
