import type { Db } from '../../lib/db.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { nextAllowedTime, type SendWindow } from '../../worker/schedule.js';
import { recordActivity } from '../activity/activity.service.js';
import { launchBlockers } from '../workspace/workspace.service.js';
import {
  allowedFrom,
  AUTO_PAUSE_PREFIX,
  canTransition,
  statusForStart,
  type CampaignAction,
} from './campaigns.lifecycle.js';
import { countEligibleRecipients } from './campaigns.service.js';

type Detail = (workspaceId: number, id: number) => Promise<unknown>;

const versionConflict = () =>
  conflict(
    'This campaign was changed somewhere else. Reload it and try again.',
    'VERSION_CONFLICT',
  );

export function createCampaignActions(db: Db, detail: Detail) {
  async function rejectTransition(
    workspaceId: number,
    id: number,
    action: CampaignAction,
  ): Promise<never> {
    const campaign = await db.campaign.findFirst({ where: { id, workspaceId } });
    if (!campaign) throw notFound('Campaign');
    throw conflict(`A ${campaign.status} campaign cannot be ${action}d`, 'INVALID_TRANSITION');
  }

  return {
    /**
     * Enrols everyone on the list who is not suppressed and schedules the first email for each,
     * all in one transaction: either the campaign launches completely or not at all.
     */
    async launch(workspaceId: number, userId: number, id: number, version: number) {
      const campaign = await db.campaign.findFirst({
        where: { id, workspaceId },
        include: { steps: { orderBy: { position: 'asc' }, take: 1 } },
      });
      if (!campaign) throw notFound('Campaign');
      if (!canTransition(campaign.status, 'launch')) {
        throw conflict(`A ${campaign.status} campaign cannot be launched`, 'INVALID_TRANSITION');
      }
      if (campaign.version !== version) throw versionConflict();

      const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
      const blockers = launchBlockers(workspace);
      const firstStep = campaign.steps[0];
      if (campaign.listId === null) blockers.push('Choose a list to send to');
      else if ((await countEligibleRecipients(db, workspaceId, campaign.listId)) === 0) {
        blockers.push('The list has no contacts who can be emailed');
      }
      if (!firstStep) blockers.push('Write at least one email');
      if (blockers.length > 0 || campaign.listId === null || !firstStep) {
        throw new AppError(
          422,
          'LAUNCH_BLOCKED',
          'This campaign cannot launch yet',
          blockers.map((message) => ({ path: 'launch', message })),
        );
      }
      const listId = campaign.listId;

      const now = new Date();
      const window: SendWindow = {
        startHour: campaign.windowStartHour,
        endHour: campaign.windowEndHour,
        weekdaysOnly: campaign.weekdaysOnly,
        timeZone: workspace.timezone,
      };
      const startsAt = campaign.startAt && campaign.startAt > now ? campaign.startAt : now;
      const firstRunAt = nextAllowedTime(startsAt, window);

      await db.$transaction(async (tx) => {
        const { count } = await tx.campaign.updateMany({
          where: { id, workspaceId, status: 'draft', version },
          data: {
            status: statusForStart(campaign.startAt, now),
            launchedAt: now,
            pauseReason: null,
            version: { increment: 1 },
          },
        });
        if (count !== 1) throw versionConflict();

        const enrolled = await tx.$executeRaw`
          INSERT INTO campaign_recipients (workspace_id, campaign_id, contact_id, status, created_at, updated_at)
          SELECT m.workspace_id, ${id}, m.contact_id, 'active', ${now}, ${now}
          FROM contact_list_members m
          JOIN contacts c ON c.id = m.contact_id AND c.workspace_id = m.workspace_id
          LEFT JOIN suppressions s ON s.workspace_id = c.workspace_id AND s.email = c.email
          WHERE m.workspace_id = ${workspaceId} AND m.list_id = ${listId} AND s.id IS NULL`;
        if (enrolled === 0) {
          throw new AppError(422, 'LAUNCH_BLOCKED', 'This campaign cannot launch yet', [
            { path: 'launch', message: 'The list has no contacts who can be emailed' },
          ]);
        }

        await tx.$executeRaw`
          INSERT INTO email_messages
            (workspace_id, campaign_id, recipient_id, step_id, to_email, status, run_at, created_at, updated_at)
          SELECT r.workspace_id, r.campaign_id, r.id, ${firstStep.id}, c.email, 'scheduled', ${firstRunAt}, ${now}, ${now}
          FROM campaign_recipients r
          JOIN contacts c ON c.id = r.contact_id
          WHERE r.campaign_id = ${id}`;

        await recordActivity(tx, {
          workspaceId,
          userId,
          action: 'campaign.launched',
          entityType: 'campaign',
          entityId: id,
          metadata: { recipients: enrolled, firstSendAt: firstRunAt.toISOString() },
        });
      });
      return detail(workspaceId, id);
    },

    async pause(workspaceId: number, userId: number, id: number) {
      const { count } = await db.campaign.updateMany({
        where: { id, workspaceId, status: { in: allowedFrom('pause') } },
        data: { status: 'paused', pauseReason: 'Paused by you', version: { increment: 1 } },
      });
      if (count === 0) await rejectTransition(workspaceId, id, 'pause');
      await recordActivity(db, {
        workspaceId,
        userId,
        action: 'campaign.paused',
        entityType: 'campaign',
        entityId: id,
      });
      return detail(workspaceId, id);
    },

    async resume(workspaceId: number, userId: number, id: number, acknowledgeBounceRate: boolean) {
      const campaign = await db.campaign.findFirst({ where: { id, workspaceId } });
      if (!campaign) throw notFound('Campaign');
      if (!canTransition(campaign.status, 'resume')) {
        throw conflict(`A ${campaign.status} campaign cannot be resumed`, 'INVALID_TRANSITION');
      }
      if (campaign.pauseReason?.startsWith(AUTO_PAUSE_PREFIX) && !acknowledgeBounceRate) {
        throw conflict(
          'This campaign was paused automatically because of its bounce or complaint rate. Review the recipients, then confirm to resume.',
          'BOUNCE_RATE_ACK_REQUIRED',
        );
      }
      const { count } = await db.campaign.updateMany({
        where: { id, workspaceId, status: 'paused' },
        data: {
          status: statusForStart(campaign.startAt, new Date()),
          pauseReason: null,
          version: { increment: 1 },
        },
      });
      if (count === 0) await rejectTransition(workspaceId, id, 'resume');
      await recordActivity(db, {
        workspaceId,
        userId,
        action: 'campaign.resumed',
        entityType: 'campaign',
        entityId: id,
      });
      return detail(workspaceId, id);
    },

    /** Cancelling is final: pending messages are cancelled and recipients stop receiving the sequence. */
    async cancel(workspaceId: number, userId: number, id: number) {
      const now = new Date();
      await db.$transaction(async (tx) => {
        const { count } = await tx.campaign.updateMany({
          where: { id, workspaceId, status: { in: allowedFrom('cancel') } },
          data: { status: 'cancelled', completedAt: now, version: { increment: 1 } },
        });
        if (count === 0) await rejectTransition(workspaceId, id, 'cancel');
        await tx.emailMessage.updateMany({
          where: {
            campaignId: id,
            OR: [{ status: 'scheduled' }, { status: 'sending', lockedUntil: { lt: now } }],
          },
          data: { status: 'cancelled', lastError: 'Campaign cancelled' },
        });
        await tx.campaignRecipient.updateMany({
          where: { campaignId: id, status: 'active' },
          data: { status: 'stopped', stopReason: 'campaign_cancelled' },
        });
        await recordActivity(tx, {
          workspaceId,
          userId,
          action: 'campaign.cancelled',
          entityType: 'campaign',
          entityId: id,
        });
      });
      return detail(workspaceId, id);
    },
  };
}

/** Used by webhook processing: pauses a live campaign when its delivery health drops. */
export async function autoPauseCampaign(
  db: Db,
  campaignId: number,
  reason: string,
): Promise<boolean> {
  const { count } = await db.campaign.updateMany({
    where: { id: campaignId, status: { in: allowedFrom('pause') } },
    data: {
      status: 'paused',
      pauseReason: `${AUTO_PAUSE_PREFIX}: ${reason}`,
      version: { increment: 1 },
    },
  });
  return count === 1;
}

/** Housekeeping: starts campaigns whose start time has arrived and completes finished ones. */
export async function advanceCampaigns(db: Db, now: Date): Promise<void> {
  await db.campaign.updateMany({
    where: { status: 'scheduled', startAt: { lte: now } },
    data: { status: 'running' },
  });
  await db.$executeRaw`
    UPDATE campaigns c
    SET c.status = 'completed', c.completed_at = ${now}, c.updated_at = ${now}, c.version = c.version + 1
    WHERE c.status = 'running'
      AND NOT EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'active')`;
}
