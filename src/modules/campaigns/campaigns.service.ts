import type { Campaign, CampaignStatus, CampaignStep } from '../../generated/prisma/client.js';
import type { Db, Tx } from '../../lib/db.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { decodeCursor, escapeLike, toPage } from '../../lib/pagination.js';
import { renderTemplate, singleLine } from '../../email/template.js';
import { recordActivity } from '../activity/activity.service.js';
import { launchBlockers } from '../workspace/workspace.service.js';
import { isEditable } from './campaigns.lifecycle.js';
import type {
  CreateCampaignInput,
  ReplaceStepsInput,
  UpdateCampaignInput,
} from './campaigns.schemas.js';
import {
  countMessagesByCampaign,
  countMessagesByStep,
  countRecipientsByCampaign,
  emptyCounts,
} from './campaigns.stats.js';

export type CampaignsService = ReturnType<typeof createCampaignsService>;

type CampaignWithList = Campaign & { list: { name: string } | null };

export function createCampaignsService(db: Db) {
  async function findOwned(client: Db | Tx, workspaceId: number, id: number) {
    const campaign = await client.campaign.findFirst({ where: { id, workspaceId } });
    if (!campaign) throw notFound('Campaign');
    return campaign;
  }

  async function assertListExists(workspaceId: number, listId: number | null | undefined) {
    if (listId === null || listId === undefined) return;
    if (!(await db.contactList.findFirst({ where: { id: listId, workspaceId } }))) {
      throw validationFailed('The selected list does not exist', [
        { path: 'listId', message: 'The selected list does not exist' },
      ]);
    }
  }

  /** Why a draft cannot launch yet. Shown in the builder and enforced again at launch. */
  async function draftBlockers(campaign: Campaign, steps: CampaignStep[]) {
    const workspace = await db.workspace.findUniqueOrThrow({ where: { id: campaign.workspaceId } });
    const blockers = launchBlockers(workspace);
    let eligibleRecipients = 0;
    if (campaign.listId === null) {
      blockers.push('Choose a list to send to');
    } else {
      eligibleRecipients = await countEligibleRecipients(db, campaign.workspaceId, campaign.listId);
      if (eligibleRecipients === 0) blockers.push('The list has no contacts who can be emailed');
    }
    if (steps.length === 0) blockers.push('Write at least one email');
    return { blockers, eligibleRecipients };
  }

  function summary(campaign: CampaignWithList, recipients: number, counts = emptyCounts()) {
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      listId: campaign.listId,
      listName: campaign.list?.name ?? null,
      startAt: campaign.startAt,
      windowStartHour: campaign.windowStartHour,
      windowEndHour: campaign.windowEndHour,
      weekdaysOnly: campaign.weekdaysOnly,
      pauseReason: campaign.pauseReason,
      version: campaign.version,
      launchedAt: campaign.launchedAt,
      completedAt: campaign.completedAt,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
      counts: { recipients, ...counts },
    };
  }

  async function detail(workspaceId: number, id: number) {
    const campaign = await db.campaign.findFirst({
      where: { id, workspaceId },
      include: { list: { select: { name: true } }, steps: { orderBy: { position: 'asc' } } },
    });
    if (!campaign) throw notFound('Campaign');
    const [recipients, byCampaign, byStep] = await Promise.all([
      countRecipientsByCampaign(db, [id]),
      countMessagesByCampaign(db, [id]),
      countMessagesByStep(db, id),
    ]);
    return {
      ...summary(campaign, recipients.get(id) ?? 0, byCampaign.get(id)),
      steps: campaign.steps.map((step) => ({
        id: step.id,
        position: step.position,
        subject: step.subject,
        body: step.body,
        delayDays: step.delayDays,
        counts: byStep.get(step.id) ?? emptyCounts(),
      })),
      launch: campaign.status === 'draft' ? await draftBlockers(campaign, campaign.steps) : null,
    };
  }

  /** Applies an edit only if the draft is still at the version the client last saw. */
  async function guardedUpdate(
    tx: Tx,
    workspaceId: number,
    id: number,
    version: number,
    data: Record<string, unknown>,
  ) {
    const { count } = await tx.campaign.updateMany({
      where: { id, workspaceId, version, status: 'draft' },
      data: { ...data, version: { increment: 1 } },
    });
    if (count === 1) return;

    const current = await findOwned(tx, workspaceId, id);
    if (!isEditable(current.status)) {
      throw conflict('Only draft campaigns can be edited', 'CAMPAIGN_LOCKED');
    }
    throw conflict(
      'This campaign was changed somewhere else. Reload it and try again.',
      'VERSION_CONFLICT',
    );
  }

  return {
    detail,
    findOwned: (workspaceId: number, id: number) => findOwned(db, workspaceId, id),

    async list(
      workspaceId: number,
      query: {
        status?: CampaignStatus | undefined;
        search?: string | undefined;
        cursor?: string | undefined;
        limit: number;
      },
    ) {
      const before = decodeCursor(query.cursor);
      const rows = await db.campaign.findMany({
        where: {
          workspaceId,
          ...(before ? { id: { lt: before } } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.search ? { name: { contains: escapeLike(query.search) } } : {}),
        },
        include: { list: { select: { name: true } } },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      const page = toPage(rows, query.limit);
      const ids = page.items.map((campaign) => campaign.id);
      const [recipients, counts] = await Promise.all([
        countRecipientsByCampaign(db, ids),
        countMessagesByCampaign(db, ids),
      ]);
      return {
        items: page.items.map((campaign) =>
          summary(campaign, recipients.get(campaign.id) ?? 0, counts.get(campaign.id)),
        ),
        nextCursor: page.nextCursor,
      };
    },

    async create(workspaceId: number, userId: number, input: CreateCampaignInput) {
      await assertListExists(workspaceId, input.listId);
      const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
      const windowStartHour = input.windowStartHour ?? workspace.windowStartHour;
      const windowEndHour = input.windowEndHour ?? workspace.windowEndHour;
      if (windowStartHour >= windowEndHour) {
        throw validationFailed('The sending window must end after it starts', [
          { path: 'windowEndHour', message: 'The sending window must end after it starts' },
        ]);
      }
      const campaign = await db.campaign.create({
        data: {
          workspaceId,
          name: input.name,
          listId: input.listId ?? null,
          startAt: input.startAt ?? null,
          windowStartHour,
          windowEndHour,
          weekdaysOnly: input.weekdaysOnly ?? workspace.weekdaysOnly,
          createdById: userId,
        },
      });
      await recordActivity(db, {
        workspaceId,
        userId,
        action: 'campaign.created',
        entityType: 'campaign',
        entityId: campaign.id,
        metadata: { name: campaign.name },
      });
      return detail(workspaceId, campaign.id);
    },

    async update(workspaceId: number, userId: number, id: number, input: UpdateCampaignInput) {
      await assertListExists(workspaceId, input.listId);
      const { version, ...fields } = input;
      const current = await findOwned(db, workspaceId, id);
      const start = fields.windowStartHour ?? current.windowStartHour;
      const end = fields.windowEndHour ?? current.windowEndHour;
      if (start >= end) {
        throw validationFailed('The sending window must end after it starts', [
          { path: 'windowEndHour', message: 'The sending window must end after it starts' },
        ]);
      }
      await db.$transaction((tx) => guardedUpdate(tx, workspaceId, id, version, fields));
      await recordActivity(db, {
        workspaceId,
        userId,
        action: 'campaign.updated',
        entityType: 'campaign',
        entityId: id,
      });
      return detail(workspaceId, id);
    },

    /** Replaces the whole sequence. Step positions follow the order of the array. */
    async replaceSteps(workspaceId: number, userId: number, id: number, input: ReplaceStepsInput) {
      await db.$transaction(async (tx) => {
        await guardedUpdate(tx, workspaceId, id, input.version, {});
        await tx.campaignStep.deleteMany({ where: { campaignId: id } });
        await tx.campaignStep.createMany({
          data: input.steps.map((step, index) => ({
            campaignId: id,
            position: index + 1,
            delayDays: index === 0 ? 0 : step.delayDays,
            subject: step.subject,
            body: step.body,
          })),
        });
      });
      await recordActivity(db, {
        workspaceId,
        userId,
        action: 'campaign.sequence_updated',
        entityType: 'campaign',
        entityId: id,
        metadata: { steps: input.steps.length },
      });
      return detail(workspaceId, id);
    },

    async remove(workspaceId: number, userId: number, id: number): Promise<void> {
      const campaign = await findOwned(db, workspaceId, id);
      if (campaign.status !== 'draft') {
        throw conflict(
          'Only draft campaigns can be deleted. Cancel it instead.',
          'CAMPAIGN_LOCKED',
        );
      }
      await db.campaign.deleteMany({ where: { id, workspaceId, status: 'draft' } });
      await recordActivity(db, {
        workspaceId,
        userId,
        action: 'campaign.deleted',
        entityType: 'campaign',
        entityId: id,
        metadata: { name: campaign.name },
      });
    },

    /** Shows one step the way a recipient would see it, using a real contact or sample values. */
    async preview(
      workspaceId: number,
      id: number,
      position: number,
      contactId: number | undefined,
    ) {
      await findOwned(db, workspaceId, id);
      const step = await db.campaignStep.findUnique({
        where: { campaignId_position: { campaignId: id, position } },
      });
      if (!step) throw notFound('Step');
      const contact = contactId
        ? await db.contact.findFirst({ where: { id: contactId, workspaceId } })
        : null;
      if (contactId && !contact) throw notFound('Contact');
      const values = contact
        ? {
            first_name: contact.firstName,
            last_name: contact.lastName,
            company: contact.company,
            email: contact.email,
          }
        : {
            first_name: 'Alex',
            last_name: 'Morgan',
            company: 'Example Co',
            email: 'alex@example.com',
          };
      return {
        subject: singleLine(renderTemplate(step.subject, values)),
        body: renderTemplate(step.body, values),
        usedSampleData: !contact,
      };
    },

    async messages(
      workspaceId: number,
      id: number,
      query: { status?: string | undefined; cursor?: string | undefined; limit: number },
    ) {
      await findOwned(db, workspaceId, id);
      const before = decodeCursor(query.cursor);
      const rows = await db.emailMessage.findMany({
        where: {
          workspaceId,
          campaignId: id,
          ...(before ? { id: { lt: before } } : {}),
          ...(query.status ? { status: query.status as never } : {}),
        },
        include: { step: { select: { position: true } } },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      const page = toPage(rows, query.limit);
      return {
        items: page.items.map((message) => ({
          id: message.id,
          toEmail: message.toEmail,
          step: message.step.position,
          status: message.status,
          runAt: message.runAt,
          attempts: message.attempts,
          acceptedAt: message.acceptedAt,
          deliveredAt: message.deliveredAt,
          failedAt: message.failedAt,
          lastError: message.lastError,
        })),
        nextCursor: page.nextCursor,
      };
    },
  };
}

/** Contacts on the list who are not suppressed. This is exactly who a launch would enrol. */
export async function countEligibleRecipients(db: Db | Tx, workspaceId: number, listId: number) {
  const rows = await db.$queryRaw<{ total: bigint }[]>`
    SELECT COUNT(*) AS total
    FROM contact_list_members m
    JOIN contacts c ON c.id = m.contact_id AND c.workspace_id = m.workspace_id
    LEFT JOIN suppressions s ON s.workspace_id = c.workspace_id AND s.email = c.email
    WHERE m.workspace_id = ${workspaceId} AND m.list_id = ${listId} AND s.id IS NULL`;
  return Number(rows[0]?.total ?? 0);
}
