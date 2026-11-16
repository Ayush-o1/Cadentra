import type { Config } from '../config/env.js';
import { composeEmail } from '../email/compose.js';
import { ProviderError, type EmailProvider } from '../email/provider.js';
import type { Db } from '../lib/db.js';
import type { Logger } from '../lib/logger.js';
import { createUnsubscribeToken } from '../modules/unsubscribe/unsubscribe.token.js';
import { startOfUtcDay } from '../modules/workspace/workspace.service.js';
import { reconcileUnmatchedEvents } from '../modules/webhooks/events.js';
import { decideRetry } from './retry.js';
import { computeRunAt, nextAllowedTime, type SendWindow } from './schedule.js';
import type { ClaimedMessage } from './claim.js';

export type ProcessorDeps = {
  db: Db;
  provider: EmailProvider;
  config: Config;
  logger: Logger;
  workerId: string;
  throttle: () => Promise<void>;
  now?: () => Date;
};

export type Outcome =
  'accepted' | 'skipped' | 'rescheduled' | 'retrying' | 'failed' | 'released' | 'lease_lost';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sends one claimed message. Everything that can change between the claim and the send is checked
 * again here: the campaign may have been paused, the contact may have unsubscribed, and the
 * workspace's window and daily limit still apply.
 */
export async function processMessage(
  deps: ProcessorDeps,
  claimed: ClaimedMessage,
): Promise<Outcome> {
  const { db, provider, config, logger, workerId } = deps;
  const now = deps.now?.() ?? new Date();

  const message = await db.emailMessage.findUnique({
    where: { id: claimed.id },
    include: { campaign: true, step: true, recipient: { include: { contact: true } } },
  });
  if (!message || message.status !== 'sending' || message.lockedBy !== workerId)
    return 'lease_lost';

  const ownedBySelf = { id: message.id, status: 'sending' as const, lockedBy: workerId };
  const release = { lockedBy: null, lockedUntil: null };
  const log = logger.child({ messageId: message.id, campaignId: message.campaignId });

  const reschedule = async (runAt: Date, outcome: Outcome) => {
    const { count } = await db.emailMessage.updateMany({
      where: ownedBySelf,
      data: { status: 'scheduled', runAt, attempts: { decrement: 1 }, ...release },
    });
    return count === 1 ? outcome : 'lease_lost';
  };

  const skip = async (reason: string, stopReason: string): Promise<Outcome> => {
    const outcome = await db.$transaction(async (tx) => {
      const { count } = await tx.emailMessage.updateMany({
        where: ownedBySelf,
        data: { status: 'skipped', lastError: reason, ...release },
      });
      if (count === 0) return 'lease_lost' as const;
      await tx.campaignRecipient.updateMany({
        where: { id: message.recipientId, status: 'active' },
        data: { status: 'stopped', stopReason },
      });
      return 'skipped' as const;
    });
    return outcome;
  };

  if (message.campaign.status !== 'running') return reschedule(message.runAt, 'released');

  const suppression = await db.suppression.findUnique({
    where: { workspaceId_email: { workspaceId: message.workspaceId, email: message.toEmail } },
  });
  if (suppression) return skip('Recipient is suppressed', suppression.reason);
  if (message.recipient.status !== 'active')
    return skip('Recipient is no longer active', 'inactive');

  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: message.workspaceId } });
  const window: SendWindow = {
    startHour: message.campaign.windowStartHour,
    endHour: message.campaign.windowEndHour,
    weekdaysOnly: message.campaign.weekdaysOnly,
    timeZone: workspace.timezone,
  };

  const windowOpensAt = nextAllowedTime(now, window);
  if (windowOpensAt.getTime() > now.getTime()) return reschedule(windowOpensAt, 'rescheduled');

  const dayStart = startOfUtcDay(now);
  const usedToday = await db.emailMessage.count({
    where: {
      workspaceId: message.workspaceId,
      id: { not: message.id },
      OR: [{ acceptedAt: { gte: dayStart } }, { status: 'sending' }],
    },
  });
  if (usedToday >= workspace.dailySendLimit) {
    const tomorrow = new Date(dayStart.getTime() + DAY_MS);
    return reschedule(nextAllowedTime(tomorrow, window), 'rescheduled');
  }

  if (!workspace.senderName || !workspace.senderEmail || !workspace.postalAddress) {
    return fail(
      deps,
      ownedBySelf,
      message.recipientId,
      'The workspace sender identity is incomplete',
      now,
    );
  }

  const unsubscribeUrl = `${config.appUrl}/u/${createUnsubscribeToken(config.appSecret, message.id)}`;
  const { email, subject } = composeEmail({
    step: message.step,
    contact: message.recipient.contact,
    sender: {
      name: workspace.senderName,
      email: workspace.senderEmail,
      replyTo: workspace.replyToEmail,
      postalAddress: workspace.postalAddress,
    },
    unsubscribeUrl,
  });

  let providerMessageId: string;
  try {
    await deps.throttle();
    ({ providerMessageId } = await provider.send(email, `cadentra-message-${message.id}`));
  } catch (error) {
    const providerError =
      error instanceof ProviderError
        ? error
        : new ProviderError(error instanceof Error ? error.message : 'Unexpected error', true);
    log.warn(
      { attempt: message.attempts, retryable: providerError.retryable },
      providerError.message,
    );
    return handleFailure(
      deps,
      ownedBySelf,
      message.recipientId,
      message.attempts,
      providerError,
      now,
    );
  }

  const nextStep = await db.campaignStep.findUnique({
    where: {
      campaignId_position: { campaignId: message.campaignId, position: message.step.position + 1 },
    },
  });

  const outcome = await db.$transaction(async (tx) => {
    const { count } = await tx.emailMessage.updateMany({
      where: ownedBySelf,
      data: {
        status: 'accepted',
        provider: provider.name,
        providerMessageId,
        acceptedAt: now,
        subjectSent: subject.slice(0, 200),
        lastError: null,
        ...release,
      },
    });
    if (count === 0) return 'lease_lost' as const;

    if (nextStep) {
      const recipient = await tx.campaignRecipient.findUnique({
        where: { id: message.recipientId },
      });
      if (recipient?.status === 'active') {
        await tx.emailMessage.createMany({
          data: [
            {
              workspaceId: message.workspaceId,
              campaignId: message.campaignId,
              recipientId: message.recipientId,
              stepId: nextStep.id,
              toEmail: message.toEmail,
              runAt: computeRunAt(now, nextStep.delayDays, window),
            },
          ],
          skipDuplicates: true,
        });
      }
    } else {
      await tx.campaignRecipient.updateMany({
        where: { id: message.recipientId, status: 'active' },
        data: { status: 'completed' },
      });
    }
    return 'accepted' as const;
  });

  if (outcome === 'accepted') {
    reconcileUnmatchedEvents(db, providerMessageId).catch((error: unknown) => {
      log.error({ err: error }, 'Could not reconcile early provider events');
    });
  } else {
    log.warn(
      'Lease was lost after the provider accepted the message; the new owner will record it',
    );
  }
  return outcome;
}

type OwnedGuard = { id: number; status: 'sending'; lockedBy: string };

async function fail(
  deps: ProcessorDeps,
  guard: OwnedGuard,
  recipientId: number,
  reason: string,
  now: Date,
): Promise<Outcome> {
  return deps.db.$transaction(async (tx) => {
    const { count } = await tx.emailMessage.updateMany({
      where: guard,
      data: {
        status: 'failed',
        failedAt: now,
        lastError: reason.slice(0, 500),
        lockedBy: null,
        lockedUntil: null,
      },
    });
    if (count === 0) return 'lease_lost' as const;
    await tx.campaignRecipient.updateMany({
      where: { id: recipientId, status: 'active' },
      data: { status: 'stopped', stopReason: 'failed' },
    });
    return 'failed' as const;
  });
}

async function handleFailure(
  deps: ProcessorDeps,
  guard: OwnedGuard,
  recipientId: number,
  attempts: number,
  error: ProviderError,
  now: Date,
): Promise<Outcome> {
  if (error.quota && error.retryable) {
    // Out of provider quota: wait for it to reset without using up one of the message's attempts.
    const { count } = await deps.db.emailMessage.updateMany({
      where: guard,
      data: {
        status: 'scheduled',
        runAt: new Date(now.getTime() + (error.retryAfterMs ?? 60 * 60 * 1000)),
        attempts: { decrement: 1 },
        lastError: error.message.slice(0, 500),
        lockedBy: null,
        lockedUntil: null,
      },
    });
    return count === 1 ? 'rescheduled' : 'lease_lost';
  }
  const decision = decideRetry({
    retryable: error.retryable,
    attempts,
    retryAfterMs: error.retryAfterMs,
    now,
  });
  if (decision.kind === 'fail') return fail(deps, guard, recipientId, error.message, now);

  const { count } = await deps.db.emailMessage.updateMany({
    where: guard,
    data: {
      status: 'scheduled',
      runAt: decision.runAt,
      lastError: error.message.slice(0, 500),
      lockedBy: null,
      lockedUntil: null,
    },
  });
  return count === 1 ? 'retrying' : 'lease_lost';
}
