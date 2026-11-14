import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/email/fake.provider.js';
import { recordProviderEvent } from '../../src/modules/webhooks/events.js';
import { buildTestApp, errorBody, registerAgent, resetDatabase } from '../helpers.js';
import { launchScenario, makeAllDue, workerFor } from '../scenario.js';

const ctx = buildTestApp();
const { app, db } = ctx;

beforeEach(async () => {
  await resetDatabase(db);
});

afterAll(async () => {
  await db.$disconnect();
});

type Totals = {
  accepted: number;
  delivered: number;
  bounced: number;
  complained: number;
  awaiting: number;
  failed: number;
};
type AnalyticsBody = {
  totals: Totals;
  rates: { delivery: number | null; bounce: number | null; complaint: number | null };
  series: {
    date: string;
    accepted: number;
    delivered: number;
    bounced: number;
    complained: number;
  }[];
  campaigns: { id: number; accepted: number; delivered: number }[];
  steps: { position: number; accepted: number; delivered: number; bounced: number }[];
};

const analytics = async (agent: Awaited<ReturnType<typeof registerAgent>>['agent'], query = '') =>
  ((await agent.get(`/api/v1/analytics${query}`)).body as { data: AnalyticsBody }).data;

async function sendAndSettle() {
  const scenario = await launchScenario(app, { contacts: 6 });
  const provider = new FakeProvider();
  const worker = workerFor(ctx, provider);
  await worker.runOnce();
  const first = await db.emailMessage.findMany({
    where: { campaignId: scenario.campaignId, step: { position: 1 } },
    orderBy: { id: 'asc' },
  });
  const event = (type: string, message: (typeof first)[number], id: string) =>
    recordProviderEvent(db, {
      provider: 'resend',
      eventId: id,
      type,
      providerMessageId: message.providerMessageId,
      occurredAt: new Date(),
    });
  // 3 delivered, 1 bounced, 1 delivered then complained, 1 still awaiting a result.
  await event('email.delivered', first[0]!, 'e1');
  await event('email.delivered', first[1]!, 'e2');
  await event('email.delivered', first[2]!, 'e3');
  await event('email.bounced', first[3]!, 'e4');
  await event('email.delivered', first[4]!, 'e5');
  await event('email.complained', first[4]!, 'e6');
  return { ...scenario, provider, worker, first };
}

describe('delivery analytics', () => {
  it('reports exactly what the message rows say', async () => {
    const { agent, workspaceId } = await sendAndSettle();
    const data = await analytics(agent);

    expect(data.totals).toEqual({
      accepted: 6,
      delivered: 4,
      bounced: 1,
      complained: 1,
      awaiting: 1,
      failed: 0,
    });
    expect(data.rates.delivery).toBeCloseTo(4 / 6);
    expect(data.rates.bounce).toBeCloseTo(1 / 6);
    expect(data.rates.complaint).toBeCloseTo(1 / 6);

    // Cross-check against direct counts instead of trusting the service's own arithmetic.
    expect(data.totals.accepted).toBe(
      await db.emailMessage.count({ where: { workspaceId, acceptedAt: { not: null } } }),
    );
    expect(data.totals.bounced).toBe(
      await db.emailMessage.count({ where: { workspaceId, status: 'bounced' } }),
    );
    expect(data.totals.delivered).toBe(
      await db.emailMessage.count({
        where: { workspaceId, status: { in: ['delivered', 'complained'] } },
      }),
    );
  });

  it('builds a gap-free daily series that adds up to the totals', async () => {
    const { agent } = await sendAndSettle();
    const data = await analytics(agent, '?range=7d');
    expect(data.series).toHaveLength(7);
    const today = new Date().toISOString().slice(0, 10);
    expect(data.series.at(-1)!.date).toBe(today);
    expect(data.series.at(-1)).toMatchObject({
      accepted: 6,
      delivered: 4,
      bounced: 1,
      complained: 1,
    });
    expect(data.series.reduce((sum, p) => sum + p.accepted, 0)).toBe(data.totals.accepted);
  });

  it('applies the time filter to when messages were accepted', async () => {
    const { agent, first } = await sendAndSettle();
    const old = new Date(Date.now() - 40 * 86_400_000);
    await db.emailMessage.updateMany({
      where: { id: { in: first.slice(0, 2).map((m) => m.id) } },
      data: { acceptedAt: old },
    });

    expect((await analytics(agent, '?range=30d')).totals.accepted).toBe(4);
    expect((await analytics(agent, '?range=90d')).totals.accepted).toBe(6);
    const from = old.toISOString().slice(0, 10);
    const to = new Date(old.getTime() + 86_400_000).toISOString().slice(0, 10);
    expect((await analytics(agent, `?from=${from}&to=${to}`)).totals.accepted).toBe(2);
  });

  it('counts messages that never reached the provider as failures, not sends', async () => {
    const { agent, campaignId, worker, first } = await sendAndSettle();
    await db.emailMessage.updateMany({
      where: { campaignId, status: 'scheduled' },
      data: { status: 'failed', failedAt: new Date(), lastError: 'Resend responded 422' },
    });
    await makeAllDue(ctx, campaignId);
    await worker.runOnce();
    const data = await analytics(agent);
    // Two of the six contacts bounced or complained, so their second emails were skipped.
    expect(data.totals.failed).toBe(first.length - 2);
    expect(data.totals.accepted).toBe(6);
  });

  it('breaks results down per campaign and per step', async () => {
    const { agent, campaignId, worker } = await sendAndSettle();
    await makeAllDue(ctx, campaignId);
    await worker.runOnce();

    const overall = await analytics(agent);
    expect(overall.campaigns).toEqual([expect.objectContaining({ id: campaignId, accepted: 10 })]);

    const detail = await analytics(agent, `?campaignId=${campaignId}`);
    expect(detail.steps.map((s) => [s.position, s.accepted])).toEqual([
      [1, 6],
      [2, 4],
    ]);
    expect(detail.steps[0]).toMatchObject({ delivered: 4, bounced: 1 });
    expect(detail.totals.accepted).toBe(10);
  });
});

describe('analytics access and validation', () => {
  it('shows an empty workspace as nothing sent, with no rates', async () => {
    const { agent } = await registerAgent(app);
    const data = await analytics(agent);
    expect(data.totals).toEqual({
      accepted: 0,
      delivered: 0,
      bounced: 0,
      complained: 0,
      awaiting: 0,
      failed: 0,
    });
    expect(data.rates).toEqual({ delivery: null, bounce: null, complaint: null });
    expect(data.campaigns).toEqual([]);
    expect(data.series.every((p) => p.accepted === 0)).toBe(true);
  });

  it('never includes another workspace data', async () => {
    const { campaignId } = await sendAndSettle();
    const stranger = await registerAgent(app);
    const data = await analytics(stranger.agent);
    expect(data.totals.accepted).toBe(0);
    const res = await stranger.agent.get(`/api/v1/analytics?campaignId=${campaignId}`);
    expect(res.status).toBe(404);
  });

  it('validates the date range', async () => {
    const { agent } = await registerAgent(app);
    expect((await agent.get('/api/v1/analytics?range=1y')).status).toBe(422);
    expect((await agent.get('/api/v1/analytics?from=2026-01-01')).status).toBe(422);
    expect((await agent.get('/api/v1/analytics?from=2026-02-01&to=2026-01-01')).status).toBe(422);
    const tooLong = await agent.get('/api/v1/analytics?from=2024-01-01&to=2026-01-01');
    expect(tooLong.status).toBe(422);
    expect(errorBody(tooLong).details?.[0]?.message).toMatch(/one year/);
  });

  it('requires a session', async () => {
    const { default: supertest } = await import('supertest');
    expect((await supertest(app).get('/api/v1/analytics')).status).toBe(401);
    expect((await supertest(app).get('/api/v1/dashboard')).status).toBe(401);
  });
});

describe('dashboard', () => {
  it('combines current state with the last 30 days of delivery', async () => {
    const { agent, campaignId } = await sendAndSettle();
    await db.suppression.createMany({
      data: [
        {
          workspaceId: (await db.workspace.findFirstOrThrow()).id,
          email: 'x@example.org',
          reason: 'manual',
        },
      ],
    });

    const res = await agent.get('/api/v1/dashboard');
    expect(res.status).toBe(200);
    const data = (
      res.body as {
        data: {
          contacts: { total: number; suppressed: number; reachable: number; lists: number };
          campaigns: { active: number; recent: { id: number }[] };
          messages: { scheduled: number; sentToday: number };
          delivery: { totals: Totals };
          trend: unknown[];
          activity: { action: string; actor: string | null }[];
        };
      }
    ).data;

    // The bounce and the complaint suppressed two contacts. The manual entry has no contact, so it is not counted.
    expect(data.contacts).toEqual({ total: 6, suppressed: 2, reachable: 4, lists: 1 });
    expect(data.campaigns.active).toBe(1);
    expect(data.campaigns.recent.map((c) => c.id)).toEqual([campaignId]);
    expect(data.messages).toEqual({ scheduled: 4, sentToday: 6 });
    expect(data.delivery.totals.accepted).toBe(6);
    expect(data.trend).toHaveLength(31);
    expect(data.activity.map((a) => a.action)).toContain('campaign.launched');
    expect(data.activity.find((a) => a.action === 'campaign.launched')?.actor).toMatch(/Test User/);
  });

  it('shows zeros for a new workspace', async () => {
    const { agent } = await registerAgent(app);
    const data = (
      (await agent.get('/api/v1/dashboard')).body as {
        data: { contacts: { total: number }; messages: { scheduled: number } };
      }
    ).data;
    expect(data.contacts.total).toBe(0);
    expect(data.messages.scheduled).toBe(0);
  });
});
