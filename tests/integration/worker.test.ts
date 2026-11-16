import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/email/fake.provider.js';
import {
  ProviderError,
  type EmailProvider,
  type OutboundEmail,
  type SendResult,
} from '../../src/email/provider.js';
import { claimDueMessages } from '../../src/worker/claim.js';
import { processMessage } from '../../src/worker/processor.js';
import { createSendThrottle } from '../../src/worker/rate-limiter.js';
import { buildTestApp, resetDatabase, testLogger } from '../helpers.js';
import { launchScenario, makeAllDue, workerFor } from '../scenario.js';

const ctx = buildTestApp({ TICK_TOKEN: 't'.repeat(32) });
const { app, db, config } = ctx;

beforeEach(async () => {
  await resetDatabase(db);
});

afterAll(async () => {
  await db.$disconnect();
});

const messagesOf = (campaignId: number) =>
  db.emailMessage.findMany({
    where: { campaignId },
    orderBy: { id: 'asc' },
    include: { step: true },
  });

describe('sending a sequence', () => {
  it('sends step one to every recipient with a compliant message and schedules step two', async () => {
    const { campaignId, emails } = await launchScenario(app, { contacts: 3 });
    const provider = new FakeProvider();
    const summary = await workerFor(ctx, provider).runOnce();

    expect(summary).toMatchObject({ claimed: 3, accepted: 3, failed: 0 });
    expect(provider.sent.map((s) => s.email.to).sort()).toEqual([...emails].sort());

    const first = provider.sent[0]!.email;
    expect(first.from).toBe('Priya at Northwind <priya@northwind.example>');
    expect(first.subject).toMatch(/^Nice to meet you, Person\d$/);
    expect(first.headers['List-Unsubscribe']).toMatch(
      /^<http:\/\/localhost:3000\/u\/\d+\.[\w-]+>$/,
    );
    expect(first.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(first.text).toContain('12 Harbour Road, Bristol BS1 4AA, United Kingdom');
    expect(first.text).toContain('because we met at an event you attended');

    const messages = await messagesOf(campaignId);
    const stepOne = messages.filter((m) => m.step.position === 1);
    const stepTwo = messages.filter((m) => m.step.position === 2);
    expect(
      stepOne.every((m) => m.status === 'accepted' && m.providerMessageId && m.acceptedAt),
    ).toBe(true);
    expect(stepTwo).toHaveLength(3);
    for (const message of stepTwo) {
      expect(message.status).toBe('scheduled');
      const accepted = stepOne.find((m) => m.recipientId === message.recipientId)!.acceptedAt!;
      expect(message.runAt.getTime() - accepted.getTime()).toBe(3 * 86_400_000);
    }
  });

  it('runs the sequence to the end, completing recipients and then the campaign', async () => {
    const { campaignId } = await launchScenario(app, { contacts: 2 });
    const provider = new FakeProvider();
    const worker = workerFor(ctx, provider);

    await worker.runOnce();
    await makeAllDue(ctx, campaignId);
    await worker.runOnce();

    expect(provider.sent).toHaveLength(4);
    expect(await db.campaignRecipient.count({ where: { campaignId, status: 'completed' } })).toBe(
      2,
    );
    expect(await db.emailMessage.count({ where: { campaignId } })).toBe(4);

    await worker.runOnce();
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe(
      'completed',
    );
  });

  it('does not create the next step twice if the first step is somehow recorded again', async () => {
    const { campaignId } = await launchScenario(app, { contacts: 1 });
    await workerFor(ctx).runOnce();
    const stepTwo = (await messagesOf(campaignId)).find((m) => m.step.position === 2)!;
    await expect(
      db.emailMessage.create({
        data: {
          workspaceId: stepTwo.workspaceId,
          campaignId,
          recipientId: stepTwo.recipientId,
          stepId: stepTwo.stepId,
          toEmail: stepTwo.toEmail,
          runAt: new Date(),
        },
      }),
    ).rejects.toThrow();
    expect(await db.emailMessage.count({ where: { campaignId } })).toBe(2);
  });
});

describe('respecting opt-outs', () => {
  it('stops later steps for someone who unsubscribes through the link in their email', async () => {
    const { campaignId, emails } = await launchScenario(app, { contacts: 3 });
    const provider = new FakeProvider();
    const worker = workerFor(ctx, provider);
    await worker.runOnce();

    const leaving = provider.sent.find((s) => s.email.to === emails[0])!;
    const url = /Unsubscribe: (\S+)/.exec(leaving.email.text)![1]!;
    const token = url.split('/u/')[1]!;
    const res = await (
      await import('supertest')
    )
      .default(app)
      .post(`/api/v1/public/unsubscribe/${token}`);
    expect(res.status).toBe(200);

    await makeAllDue(ctx, campaignId);
    await worker.runOnce();

    expect(provider.sent).toHaveLength(5);
    expect(provider.sent.slice(3).map((s) => s.email.to)).not.toContain(emails[0]);
    const skipped = (await messagesOf(campaignId)).filter((m) => m.status === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.toEmail).toBe(emails[0]);
  });

  it('re-checks suppression at send time even if the stored message was never touched', async () => {
    const { campaignId, workspaceId, emails } = await launchScenario(app, { contacts: 2 });
    await db.suppression.create({ data: { workspaceId, email: emails[1]!, reason: 'manual' } });

    const provider = new FakeProvider();
    const summary = await workerFor(ctx, provider).runOnce();

    expect(summary).toMatchObject({ accepted: 1, skipped: 1 });
    expect(provider.sent.map((s) => s.email.to)).toEqual([emails[0]]);
    const recipient = await db.campaignRecipient.findFirstOrThrow({
      where: { campaignId, contact: { email: emails[1]! } },
    });
    expect(recipient).toMatchObject({ status: 'stopped', stopReason: 'manual' });
  });
});

describe('campaign state', () => {
  it('sends nothing while a campaign is paused and carries on after resume', async () => {
    const { agent, campaignId } = await launchScenario(app, { contacts: 2 });
    const provider = new FakeProvider();
    const worker = workerFor(ctx, provider);

    await agent.post(`/api/v1/campaigns/${campaignId}/pause`);
    expect((await worker.runOnce()).claimed).toBe(0);
    expect(provider.sent).toHaveLength(0);

    await agent.post(`/api/v1/campaigns/${campaignId}/resume`).send({});
    expect((await worker.runOnce()).accepted).toBe(2);
  });

  it('never sends for a cancelled campaign', async () => {
    const { agent, campaignId } = await launchScenario(app, { contacts: 2 });
    await agent.post(`/api/v1/campaigns/${campaignId}/cancel`);
    const provider = new FakeProvider();
    expect((await workerFor(ctx, provider).runOnce()).claimed).toBe(0);
    expect(provider.sent).toHaveLength(0);
  });

  it('releases a message whose campaign was paused after it was claimed', async () => {
    const { agent, campaignId } = await launchScenario(app, { contacts: 1 });
    const [claimed] = await claimDueMessages(db, {
      now: new Date(),
      limit: 1,
      workerId: 'w1',
      leaseMs: 60_000,
    });
    await agent.post(`/api/v1/campaigns/${campaignId}/pause`);

    const provider = new FakeProvider();
    const outcome = await processMessage(
      {
        db,
        provider,
        config,
        logger: testLogger(),
        workerId: 'w1',
        throttle: createSendThrottle(1000),
      },
      claimed!,
    );
    expect(outcome).toBe('released');
    expect(provider.sent).toHaveLength(0);
    const message = await db.emailMessage.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(message).toMatchObject({ status: 'scheduled', attempts: 0, lockedBy: null });
  });
});

describe('sending limits', () => {
  async function processAt(now: Date, workerId = 'w1') {
    const provider = new FakeProvider();
    const claimed = await claimDueMessages(db, { now, limit: 10, workerId, leaseMs: 60_000 });
    const outcomes = [];
    for (const message of claimed) {
      outcomes.push(
        await processMessage(
          {
            db,
            provider,
            config,
            logger: testLogger(),
            workerId,
            throttle: createSendThrottle(1000),
            now: () => now,
          },
          message,
        ),
      );
    }
    return { provider, outcomes };
  }

  it('holds a message until the sending window opens, without counting it as an attempt', async () => {
    const { campaignId } = await launchScenario(app, { contacts: 1 });
    await db.campaign.update({
      where: { id: campaignId },
      data: { windowStartHour: 9, windowEndHour: 10 },
    });

    const { provider, outcomes } = await processAt(new Date(Date.now() + 3_600_000 * 24 * 2));
    const message = (await messagesOf(campaignId))[0]!;
    expect(outcomes).toEqual(['rescheduled']);
    expect(provider.sent).toHaveLength(0);
    expect(message.status).toBe('scheduled');
    expect(message.attempts).toBe(0);
    expect(message.runAt.getUTCHours()).toBe(9);
    expect(message.runAt.getUTCMinutes()).toBe(0);
  });

  it('stops at the daily limit and moves the rest to the next day', async () => {
    const { campaignId, workspaceId } = await launchScenario(app, { contacts: 4 });
    await db.workspace.update({ where: { id: workspaceId }, data: { dailySendLimit: 2 } });

    const provider = new FakeProvider();
    const summary = await workerFor(ctx, provider).runOnce();
    expect(summary).toMatchObject({ accepted: 2, rescheduled: 2 });

    const waiting = (await messagesOf(campaignId)).filter(
      (m) => m.status === 'scheduled' && m.step.position === 1,
    );
    expect(waiting).toHaveLength(2);
    const tomorrow = new Date();
    tomorrow.setUTCHours(0, 0, 0, 0);
    expect(waiting.every((m) => m.runAt.getTime() >= tomorrow.getTime() + 86_400_000)).toBe(true);
  });

  it('fails a message when the sender identity was removed after launch', async () => {
    const { campaignId, workspaceId } = await launchScenario(app, { contacts: 1 });
    await db.workspace.update({ where: { id: workspaceId }, data: { postalAddress: null } });
    const summary = await workerFor(ctx).runOnce();
    expect(summary.failed).toBe(1);
    expect((await messagesOf(campaignId))[0]!.lastError).toMatch(/sender identity/i);
  });
});

describe('failures and retries', () => {
  it('retries a transient failure after a backoff and then succeeds', async () => {
    const { campaignId } = await launchScenario(app, { contacts: 1 });
    const provider = new FakeProvider();
    provider.failNext(new ProviderError('Resend responded 503', true));
    const worker = workerFor(ctx, provider);

    expect((await worker.runOnce()).retrying).toBe(1);
    const retrying = (await messagesOf(campaignId))[0]!;
    expect(retrying).toMatchObject({
      status: 'scheduled',
      attempts: 1,
      lastError: 'Resend responded 503',
    });
    const waitMs = retrying.runAt.getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(55_000);
    expect(waitMs).toBeLessThanOrEqual(61_000);

    await makeAllDue(ctx, campaignId);
    expect((await worker.runOnce()).accepted).toBe(1);
    expect((await messagesOf(campaignId))[0]).toMatchObject({
      status: 'accepted',
      attempts: 2,
      lastError: null,
    });
  });

  it('fails a permanent error at once and stops that recipient', async () => {
    const { campaignId } = await launchScenario(app, { contacts: 2 });
    const provider = new FakeProvider();
    provider.failNext(new ProviderError('Resend responded 422: Invalid `to` field', false));
    const worker = workerFor(ctx, provider);

    const summary = await worker.runOnce();
    expect(summary).toMatchObject({ failed: 1, accepted: 1 });
    const failed = (await messagesOf(campaignId)).find((m) => m.status === 'failed')!;
    expect(failed.lastError).toContain('422');
    expect(failed.attempts).toBe(1);
    expect(
      await db.campaignRecipient.count({
        where: { campaignId, status: 'stopped', stopReason: 'failed' },
      }),
    ).toBe(1);
  });

  it('gives up after the maximum number of attempts', async () => {
    const { campaignId } = await launchScenario(app, { contacts: 1 });
    const provider = new FakeProvider();
    provider.failNext(...Array.from({ length: 5 }, () => new ProviderError('timeout', true)));
    const worker = workerFor(ctx, provider);

    for (let attempt = 1; attempt <= 5; attempt++) {
      await worker.runOnce();
      await makeAllDue(ctx, campaignId);
    }
    const message = (await messagesOf(campaignId))[0]!;
    expect(message).toMatchObject({ status: 'failed', attempts: 5 });
    expect(provider.sent).toHaveLength(0);
  });

  it('waits for the provider quota to reset without using up an attempt', async () => {
    const { campaignId } = await launchScenario(app, { contacts: 2 });
    const provider = new FakeProvider();
    const quota = new ProviderError('Resend responded 429: quota', true, 3 * 3_600_000, {
      quota: true,
    });
    provider.failNext(quota, quota);
    const before = Date.now();

    const summary = await workerFor(ctx, provider).runOnce();

    expect(summary).toMatchObject({ claimed: 2, rescheduled: 2, failed: 0, accepted: 0 });
    for (const message of await messagesOf(campaignId)) {
      expect(message).toMatchObject({ status: 'scheduled', attempts: 0, lockedBy: null });
      expect(message.runAt.getTime()).toBeGreaterThanOrEqual(before + 3 * 3_600_000);
      expect(message.lastError).toContain('quota');
    }
  });

  it('keeps going when the provider crashes with an unexpected error', async () => {
    const { campaignId } = await launchScenario(app, { contacts: 2 });
    const exploding: EmailProvider = {
      name: 'fake',
      send: () => Promise.reject(new TypeError('socket hang up')),
    };
    const summary = await workerFor(ctx, exploding).runOnce();
    expect(summary.retrying).toBe(2);
    expect(
      (await messagesOf(campaignId)).every((m) => m.status === 'scheduled' && m.attempts === 1),
    ).toBe(true);
  });
});

describe('duplicate-send prevention', () => {
  it('does not send twice when a worker crashed after the provider accepted the email', async () => {
    const { campaignId } = await launchScenario(app, { contacts: 1 });
    const provider = new FakeProvider();

    // Worker A claims the message and the provider accepts it, but A dies before saving the result.
    const [claimed] = await claimDueMessages(db, {
      now: new Date(),
      limit: 1,
      workerId: 'crashed',
      leaseMs: 60_000,
    });
    const lost = (await messagesOf(campaignId))[0]!;
    const { providerMessageId } = await provider.send(
      {
        from: 'x',
        to: lost.toEmail,
        replyTo: undefined,
        subject: 's',
        text: 't',
        html: 'h',
        headers: {},
      },
      `cadentra-message-${claimed!.id}`,
    );
    expect(provider.sent).toHaveLength(1);

    // The lease expires and worker B picks the message up and sends it again with the same key.
    await db.emailMessage.update({
      where: { id: claimed!.id },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    const summary = await workerFor(ctx, provider).runOnce();

    expect(summary.accepted).toBe(1);
    expect(provider.sent).toHaveLength(1);
    const recovered = (await messagesOf(campaignId)).find((m) => m.id === claimed!.id)!;
    expect(recovered).toMatchObject({ status: 'accepted', providerMessageId, attempts: 2 });
  });

  it.each(['skip-locked', 'conditional-update'] as const)(
    'never hands one message to two workers running at the same time (%s)',
    async (mode) => {
      class CountingProvider implements EmailProvider {
        readonly name = 'fake' as const;
        readonly calls: string[] = [];
        async send(email: OutboundEmail, key: string): Promise<SendResult> {
          this.calls.push(key);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { providerMessageId: `count_${key}` };
        }
      }
      const { campaignId } = await launchScenario(app, { contacts: 30 });
      const provider = new CountingProvider();
      const modeCtx = {
        ...ctx,
        config: { ...config, worker: { ...config.worker, claimMode: mode } },
      };

      await Promise.all([
        workerFor(modeCtx, provider).runOnce(),
        workerFor(modeCtx, provider).runOnce(),
        workerFor(modeCtx, provider).runOnce(),
      ]);

      expect(provider.calls).toHaveLength(30);
      expect(new Set(provider.calls).size).toBe(30);
      const stepOne = (await messagesOf(campaignId)).filter((m) => m.step.position === 1);
      expect(stepOne.every((m) => m.status === 'accepted' && m.attempts === 1)).toBe(true);
    },
  );
});

describe('worker lifecycle', () => {
  it('processes work in the background and stops cleanly when asked', async () => {
    const { campaignId } = await launchScenario(app, { contacts: 4 });
    const provider = new FakeProvider();
    const worker = workerFor(ctx, provider);
    worker.start();

    const deadline = Date.now() + 10_000;
    while (provider.sent.length < 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await worker.stop();
    expect(provider.sent).toHaveLength(4);

    await makeAllDue(ctx, campaignId);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(provider.sent).toHaveLength(4);
    expect(await db.emailMessage.count({ where: { campaignId, status: 'sending' } })).toBe(0);
  });

  it('can be driven by an authenticated tick for hosts that sleep', async () => {
    const { default: supertest } = await import('supertest');
    const tickApp = buildTestApp({ TICK_TOKEN: 't'.repeat(32) }, (base) => base);
    const { createApp } = await import('../../src/app.js');
    const provider = new FakeProvider();
    const worker = workerFor(ctx, provider);
    const server = createApp({ config, logger: testLogger(), db, provider, worker });
    await tickApp.db.$disconnect();

    await launchScenario(app, { contacts: 2 });
    expect((await supertest(server).post('/internal/tick')).status).toBe(401);
    expect(
      (await supertest(server).post('/internal/tick').set('Authorization', 'Bearer wrong')).status,
    ).toBe(401);
    const res = await supertest(server)
      .post('/internal/tick')
      .set('Authorization', `Bearer ${'t'.repeat(32)}`);
    expect(res.status).toBe(200);
    expect((res.body as { data: { accepted: number } }).data.accepted).toBe(2);
    expect(provider.sent).toHaveLength(2);

    const disabled = createApp({
      config: { ...config, worker: { ...config.worker, tickToken: undefined } },
      logger: testLogger(),
      db,
      provider,
      worker,
    });
    expect((await supertest(disabled).post('/internal/tick')).status).toBe(404);
  });
});
