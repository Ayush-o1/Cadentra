import type { MessageStatus } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';

export const MESSAGE_STATUSES: MessageStatus[] = [
  'scheduled',
  'sending',
  'accepted',
  'delivered',
  'bounced',
  'complained',
  'failed',
  'skipped',
  'cancelled',
];

export type StatusCounts = Record<MessageStatus, number>;

export function emptyCounts(): StatusCounts {
  return Object.fromEntries(MESSAGE_STATUSES.map((status) => [status, 0])) as StatusCounts;
}

export async function countMessagesByCampaign(db: Db, campaignIds: number[]) {
  const byCampaign = new Map<number, StatusCounts>(campaignIds.map((id) => [id, emptyCounts()]));
  if (campaignIds.length === 0) return byCampaign;
  const groups = await db.emailMessage.groupBy({
    by: ['campaignId', 'status'],
    where: { campaignId: { in: campaignIds } },
    _count: { _all: true },
  });
  for (const group of groups) {
    byCampaign.get(group.campaignId)![group.status] = group._count._all;
  }
  return byCampaign;
}

export async function countMessagesByStep(db: Db, campaignId: number) {
  const byStep = new Map<number, StatusCounts>();
  const groups = await db.emailMessage.groupBy({
    by: ['stepId', 'status'],
    where: { campaignId },
    _count: { _all: true },
  });
  for (const group of groups) {
    const counts = byStep.get(group.stepId) ?? emptyCounts();
    counts[group.status] = group._count._all;
    byStep.set(group.stepId, counts);
  }
  return byStep;
}

export async function countRecipientsByCampaign(db: Db, campaignIds: number[]) {
  const counts = new Map<number, number>(campaignIds.map((id) => [id, 0]));
  if (campaignIds.length === 0) return counts;
  const groups = await db.campaignRecipient.groupBy({
    by: ['campaignId'],
    where: { campaignId: { in: campaignIds } },
    _count: { _all: true },
  });
  for (const group of groups) counts.set(group.campaignId, group._count._all);
  return counts;
}
