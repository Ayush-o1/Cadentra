import { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { notFound } from '../../lib/errors.js';
import { startOfUtcDay } from '../workspace/workspace.service.js';
import {
  computeRates,
  fillSeries,
  isoDay,
  RATE_LIMITS,
  resolveRange,
  type DeliveryCounts,
  type RangeInput,
  type SeriesPoint,
} from './analytics.math.js';

type CountRow = {
  accepted: bigint | number;
  delivered: bigint | number | null;
  bounced: bigint | number | null;
  complained: bigint | number | null;
  awaiting: bigint | number | null;
};

const n = (value: bigint | number | null | undefined): number => Number(value ?? 0);

export function createAnalyticsService(db: Db) {
  const scope = (workspaceId: number, from: Date, to: Date, campaignId?: number) => {
    const conditions = [
      Prisma.sql`workspace_id = ${workspaceId}`,
      Prisma.sql`accepted_at >= ${from}`,
      Prisma.sql`accepted_at < ${to}`,
    ];
    if (campaignId !== undefined) conditions.push(Prisma.sql`campaign_id = ${campaignId}`);
    return Prisma.join(conditions, ' AND ');
  };

  async function totals(
    workspaceId: number,
    from: Date,
    to: Date,
    campaignId?: number,
  ): Promise<DeliveryCounts> {
    const [row] = await db.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS accepted,
             SUM(status IN ('delivered', 'complained')) AS delivered,
             SUM(status = 'bounced') AS bounced,
             SUM(status = 'complained') AS complained,
             SUM(status = 'accepted') AS awaiting
      FROM email_messages
      WHERE ${scope(workspaceId, from, to, campaignId)}`;
    const failed = await db.emailMessage.count({
      where: {
        workspaceId,
        status: 'failed',
        failedAt: { gte: from, lt: to },
        ...(campaignId !== undefined ? { campaignId } : {}),
      },
    });
    return {
      accepted: n(row?.accepted),
      delivered: n(row?.delivered),
      bounced: n(row?.bounced),
      complained: n(row?.complained),
      awaiting: n(row?.awaiting),
      failed,
    };
  }

  async function series(
    workspaceId: number,
    from: Date,
    to: Date,
    campaignId?: number,
  ): Promise<SeriesPoint[]> {
    const rows = await db.$queryRaw<(CountRow & { day: string })[]>`
      SELECT DATE_FORMAT(accepted_at, '%Y-%m-%d') AS day,
             COUNT(*) AS accepted,
             SUM(status IN ('delivered', 'complained')) AS delivered,
             SUM(status = 'bounced') AS bounced,
             SUM(status = 'complained') AS complained
      FROM email_messages
      WHERE ${scope(workspaceId, from, to, campaignId)}
      GROUP BY day
      ORDER BY day`;
    return fillSeries(
      from,
      to,
      rows.map((row) => ({
        date: row.day,
        accepted: n(row.accepted),
        delivered: n(row.delivered),
        bounced: n(row.bounced),
        complained: n(row.complained),
      })),
    );
  }

  return {
    async analytics(workspaceId: number, input: RangeInput & { campaignId?: number | undefined }) {
      const { from, to } = resolveRange(input, new Date());
      if (input.campaignId !== undefined) {
        const exists = await db.campaign.findFirst({
          where: { id: input.campaignId, workspaceId },
          select: { id: true },
        });
        if (!exists) throw notFound('Campaign');
      }

      const [overall, points] = await Promise.all([
        totals(workspaceId, from, to, input.campaignId),
        series(workspaceId, from, to, input.campaignId),
      ]);

      const perCampaign = await db.$queryRaw<
        (CountRow & { id: number; name: string; status: string })[]
      >`
        SELECT c.id, c.name, c.status,
               COUNT(*) AS accepted,
               SUM(m.status IN ('delivered', 'complained')) AS delivered,
               SUM(m.status = 'bounced') AS bounced,
               SUM(m.status = 'complained') AS complained,
               SUM(m.status = 'accepted') AS awaiting
        FROM email_messages m
        JOIN campaigns c ON c.id = m.campaign_id
        WHERE m.workspace_id = ${workspaceId} AND m.accepted_at >= ${from} AND m.accepted_at < ${to}
        GROUP BY c.id, c.name, c.status
        ORDER BY accepted DESC, c.id DESC
        LIMIT 50`;

      const perStep =
        input.campaignId === undefined
          ? []
          : await db.$queryRaw<(CountRow & { position: number; subject: string })[]>`
              SELECT s.position, s.subject,
                     COUNT(*) AS accepted,
                     SUM(m.status IN ('delivered', 'complained')) AS delivered,
                     SUM(m.status = 'bounced') AS bounced,
                     SUM(m.status = 'complained') AS complained,
                     SUM(m.status = 'accepted') AS awaiting
              FROM email_messages m
              JOIN campaign_steps s ON s.id = m.step_id
              WHERE m.workspace_id = ${workspaceId} AND m.campaign_id = ${input.campaignId}
                AND m.accepted_at >= ${from} AND m.accepted_at < ${to}
              GROUP BY s.position, s.subject
              ORDER BY s.position`;

      const shape = (row: CountRow): DeliveryCounts & { failed: number } => ({
        accepted: n(row.accepted),
        delivered: n(row.delivered),
        bounced: n(row.bounced),
        complained: n(row.complained),
        awaiting: n(row.awaiting),
        failed: 0,
      });

      return {
        range: { from: from.toISOString(), to: to.toISOString() },
        totals: overall,
        rates: computeRates(overall),
        limits: RATE_LIMITS,
        series: points,
        campaigns: perCampaign.map((row) => ({
          id: row.id,
          name: row.name,
          status: row.status,
          ...shape(row),
          rates: computeRates(shape(row)),
        })),
        steps: perStep.map((row) => ({
          position: row.position,
          subject: row.subject,
          ...shape(row),
          rates: computeRates(shape(row)),
        })),
      };
    },

    /** The numbers on the dashboard home: what exists now plus the last 30 days of delivery. */
    async dashboard(workspaceId: number) {
      const now = new Date();
      const to = new Date(now.getTime() + 1000);
      const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const [
        contacts,
        suppressed,
        lists,
        activeCampaigns,
        scheduledMessages,
        sentToday,
        recent,
        activity,
        delivery,
        trend,
      ] = await Promise.all([
        db.contact.count({ where: { workspaceId } }),
        db.$queryRaw<{ total: bigint }[]>`
              SELECT COUNT(*) AS total
              FROM contacts c
              JOIN suppressions s ON s.workspace_id = c.workspace_id AND s.email = c.email
              WHERE c.workspace_id = ${workspaceId}`.then((rows) => n(rows[0]?.total)),
        db.contactList.count({ where: { workspaceId } }),
        db.campaign.count({ where: { workspaceId, status: { in: ['running', 'scheduled'] } } }),
        db.emailMessage.count({ where: { workspaceId, status: { in: ['scheduled', 'sending'] } } }),
        db.emailMessage.count({ where: { workspaceId, acceptedAt: { gte: startOfUtcDay(now) } } }),
        db.campaign.findMany({
          where: { workspaceId },
          orderBy: { id: 'desc' },
          take: 5,
          select: { id: true, name: true, status: true, updatedAt: true },
        }),
        db.activityLog.findMany({
          where: { workspaceId },
          orderBy: { id: 'desc' },
          take: 8,
          include: { user: { select: { name: true } } },
        }),
        totals(workspaceId, from, to),
        series(workspaceId, from, to),
      ]);

      return {
        contacts: {
          total: contacts,
          suppressed,
          reachable: Math.max(contacts - suppressed, 0),
          lists,
        },
        campaigns: { active: activeCampaigns, recent },
        messages: { scheduled: scheduledMessages, sentToday },
        delivery: {
          totals: delivery,
          rates: computeRates(delivery),
          limits: RATE_LIMITS,
          since: isoDay(from),
        },
        trend,
        activity: activity.map((entry) => ({
          id: entry.id,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          metadata: entry.metadata,
          actor: entry.user?.name ?? null,
          createdAt: entry.createdAt,
        })),
      };
    },
  };
}
