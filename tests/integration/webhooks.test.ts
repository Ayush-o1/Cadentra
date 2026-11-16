import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/email/fake.provider.js';
import { reconcileUnmatchedEvents } from '../../src/modules/webhooks/events.js';
import { buildTestApp, errorBody, resetDatabase } from '../helpers.js';
import { launchScenario, workerFor } from '../scenario.js';

const SECRET_BYTES = Buffer.from('a-test-signing-secret-of-32-bytes!');
const WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;

const ctx = buildTestApp({
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_test',
  RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
  SYSTEM_EMAIL_FROM: 'Cadentra <system@example.org>',
});
const { app, db } = ctx;

beforeEach(async () => {
  await resetDatabase(db);
});

afterAll(async () => {
  await db.$disconnect();
});

/** Signs a payload the way Svix (and therefore Resend) does. */
function sign(id: string, timestamp: number, body: string): string {
  const signature = createHmac('sha256', SECRET_BYTES)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return `v1,${signature}`;
}

let eventCounter = 0;

function deliver(
  type: string,
  emailId: string,
  options: {
    id?: string;
    timestamp?: number;
    tamper?: boolean;
    unsigned?: boolean;
    createdAt?: string;
  } = {},
) {
  eventCounter += 1;
  const id = options.id ?? `msg_evt_${eventCounter}`;
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    type,
    created_at: options.createdAt ?? new Date().toISOString(),
    data: { email_id: emailId, to: ['someone@example.org'] },
  });
  const req = request(app).post('/webhooks/resend').set('Content-Type', 'application/json');
  if (!options.unsigned) {
    req
      .set('svix-id', id)
      .set('svix-timestamp', String(timestamp))
      .set('svix-signature', sign(id, timestamp, body));
  }
  return req.send(options.tamper ? body.replace('someone', 'attacker') : body);
}

async function sentCampaign(contacts = 3) {
  const scenario = await launchScenario(app, { contacts });
  const provider = new FakeProvider();
  await workerFor(ctx, provider).runOnce();
  const messages = await db.emailMessage.findMany({
    where: { campaignId: scenario.campaignId, step: { position: 1 } },
    orderBy: { id: 'asc' },
  });
  return { ...scenario, messages, provider };
}

const statusOf = async (id: number) =>
  (await db.emailMessage.findUniqueOrThrow({ where: { id } })).status;

describe('signature verification', () => {
  it('accepts a correctly signed event', async () => {
    const { messages } = await sentCampaign(1);
    const res = await deliver('email.delivered', messages[0]!.providerMessageId!);
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe('applied');
  });

  it('rejects events with a forged signature, no signature or a changed body', async () => {
    const { messages } = await sentCampaign(1);
    const emailId = messages[0]!.providerMessageId!;
    for (const options of [{ unsigned: true }, { tamper: true }]) {
      const res = await deliver('email.bounced', emailId, options);
      expect(res.status).toBe(400);
      expect(errorBody(res).code).toBe('INVALID_SIGNATURE');
    }
    const wrongKey = await request(app)
      .post('/webhooks/resend')
      .set('Content-Type', 'application/json')
      .set('svix-id', 'msg_x')
      .set('svix-timestamp', String(Math.floor(Date.now() / 1000)))
      .set('svix-signature', 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
      .send('{"type":"email.bounced","data":{}}');
    expect(wrongKey.status).toBe(400);

    expect(await db.webhookEvent.count()).toBe(0);
    expect(await statusOf(messages[0]!.id)).toBe('accepted');
    expect(await db.suppression.count()).toBe(0);
  });

  it('rejects an old event, which stops replay of a captured request', async () => {
    const { messages } = await sentCampaign(1);
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const res = await deliver('email.delivered', messages[0]!.providerMessageId!, {
      timestamp: tenMinutesAgo,
    });
    expect(res.status).toBe(400);
  });
});

describe('applying events', () => {
  it('marks a message delivered and records when', async () => {
    const { messages } = await sentCampaign(1);
    const createdAt = '2026-11-17T10:00:05.000Z';
    await deliver('email.delivered', messages[0]!.providerMessageId!, { createdAt });
    const message = await db.emailMessage.findUniqueOrThrow({ where: { id: messages[0]!.id } });
    expect(message.status).toBe('delivered');
    expect(message.deliveredAt?.toISOString()).toBe(createdAt);
    const event = await db.webhookEvent.findFirstOrThrow();
    expect(event).toMatchObject({
      provider: 'resend',
      eventType: 'email.delivered',
      status: 'processed',
    });
  });

  it('applies a redelivered event only once', async () => {
    const { messages } = await sentCampaign(1);
    const emailId = messages[0]!.providerMessageId!;
    const first = await deliver('email.bounced', emailId, { id: 'msg_same' });
    const second = await deliver('email.bounced', emailId, { id: 'msg_same' });
    expect((first.body as { status: string }).status).toBe('applied');
    expect((second.body as { status: string }).status).toBe('duplicate');
    expect(await db.webhookEvent.count()).toBe(1);
    expect(await db.suppression.count()).toBe(1);
  });

  it('never moves a message backwards when events arrive out of order', async () => {
    const { messages } = await sentCampaign(3);
    const [bounced, complained, delivered] = messages;

    await deliver('email.bounced', bounced!.providerMessageId!);
    await deliver('email.delivered', bounced!.providerMessageId!);
    expect(await statusOf(bounced!.id)).toBe('bounced');

    await deliver('email.delivered', complained!.providerMessageId!);
    await deliver('email.complained', complained!.providerMessageId!);
    await deliver('email.delivered', complained!.providerMessageId!, { id: 'msg_late' });
    expect(await statusOf(complained!.id)).toBe('complained');

    await deliver('email.delivered', delivered!.providerMessageId!);
    await deliver('email.sent', delivered!.providerMessageId!);
    expect(await statusOf(delivered!.id)).toBe('delivered');
  });

  it('suppresses a bounced address, stops its sequence and shows it in the contact list', async () => {
    const { agent, campaignId, messages, emails } = await sentCampaign(2);
    await deliver('email.bounced', messages[0]!.providerMessageId!);

    const suppression = await db.suppression.findFirstOrThrow();
    expect(suppression).toMatchObject({
      email: emails[0],
      reason: 'hard_bounce',
      sourceMessageId: messages[0]!.id,
    });
    expect(
      await db.emailMessage.count({
        where: { campaignId, toEmail: emails[0]!, status: 'skipped' },
      }),
    ).toBe(1);
    expect(
      await db.campaignRecipient.count({
        where: { campaignId, status: 'stopped', stopReason: 'hard_bounce' },
      }),
    ).toBe(1);

    const contacts = (await agent.get('/api/v1/contacts?status=suppressed')).body as {
      data: { email: string; suppressionReason: string }[];
    };
    expect(contacts.data).toEqual([
      expect.objectContaining({ email: emails[0], suppressionReason: 'hard_bounce' }),
    ]);
  });

  it('suppresses a complaint and cannot be undone through the API', async () => {
    const { agent, messages } = await sentCampaign(1);
    await deliver('email.complained', messages[0]!.providerMessageId!);
    const suppression = await db.suppression.findFirstOrThrow();
    expect(suppression.reason).toBe('complaint');
    expect((await agent.delete(`/api/v1/suppressions/${suppression.id}`)).status).toBe(409);
  });

  it('gives a redelivered event another chance if the first attempt stored it but could not apply it', async () => {
    const { messages } = await sentCampaign(1);
    const message = messages[0]!;
    // What a crash between storing the event and applying it leaves behind.
    await db.webhookEvent.create({
      data: {
        provider: 'resend',
        providerEventId: 'msg_evt_stuck',
        eventType: 'email.delivered',
        providerMessageId: message.providerMessageId,
        status: 'unmatched',
      },
    });
    expect(await statusOf(message.id)).toBe('accepted');

    const retry = await deliver('email.delivered', message.providerMessageId!, {
      id: 'msg_evt_stuck',
    });
    expect((retry.body as { status: string }).status).toBe('applied');
    expect(await statusOf(message.id)).toBe('delivered');

    const again = await deliver('email.delivered', message.providerMessageId!, {
      id: 'msg_evt_stuck',
    });
    expect((again.body as { status: string }).status).toBe('duplicate');
  });

  it('records a delayed delivery as a note without changing the status', async () => {
    const { messages } = await sentCampaign(1);
    await deliver('email.delivery_delayed', messages[0]!.providerMessageId!);
    const message = await db.emailMessage.findUniqueOrThrow({ where: { id: messages[0]!.id } });
    expect(message.status).toBe('accepted');
    expect(message.lastError).toMatch(/delayed/i);
  });

  it('stores events it does not act on as ignored', async () => {
    const { messages } = await sentCampaign(1);
    const res = await deliver('email.opened', messages[0]!.providerMessageId!);
    expect((res.body as { status: string }).status).toBe('ignored');
    expect(await statusOf(messages[0]!.id)).toBe('accepted');
  });

  it('keeps an event for an unknown message and applies it once the message is known', async () => {
    const res = await deliver('email.delivered', 're_not_recorded_yet');
    expect((res.body as { status: string }).status).toBe('unmatched');
    expect((await db.webhookEvent.findFirstOrThrow()).status).toBe('unmatched');

    const { messages } = await sentCampaign(1);
    await db.emailMessage.update({
      where: { id: messages[0]!.id },
      data: { providerMessageId: 're_not_recorded_yet' },
    });
    expect(await reconcileUnmatchedEvents(db, 're_not_recorded_yet')).toBe(1);
    expect(await statusOf(messages[0]!.id)).toBe('delivered');
    expect((await db.webhookEvent.findFirstOrThrow()).status).toBe('processed');
  });
});

describe('bounce circuit breaker', () => {
  it('pauses a campaign once its bounce rate crosses the limit with enough sends', async () => {
    const { agent, campaignId, messages } = await sentCampaign(40);
    expect(messages).toHaveLength(40);

    await deliver('email.bounced', messages[0]!.providerMessageId!);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe(
      'running',
    );

    await deliver('email.bounced', messages[1]!.providerMessageId!);
    const campaign = await db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('paused');
    expect(campaign.pauseReason).toMatch(/^Auto-paused: bounce rate 5\.0%/);

    const resume = await agent.post(`/api/v1/campaigns/${campaignId}/resume`).send({});
    expect(errorBody(resume).code).toBe('BOUNCE_RATE_ACK_REQUIRED');
  });

  it('leaves small campaigns alone because a handful of sends proves nothing', async () => {
    const { campaignId, messages } = await sentCampaign(5);
    for (const message of messages.slice(0, 3))
      await deliver('email.bounced', message.providerMessageId!);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe(
      'running',
    );
  });

  it('pauses on a complaint once the sample is large enough', async () => {
    const { campaignId, messages } = await sentCampaign(25);
    await deliver('email.complained', messages[0]!.providerMessageId!);
    const campaign = await db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('paused');
    expect(campaign.pauseReason).toMatch(/complaint rate/);
  });
});

describe('simulated provider events', () => {
  it('mirrors Resend test addresses so local development shows real status changes', async () => {
    const events: { type: string; providerMessageId: string }[] = [];
    const provider = new FakeProvider({ eventDelayMs: 1, onEvent: (event) => events.push(event) });
    const base = {
      from: 'a <a@b.example>',
      replyTo: undefined,
      subject: 's',
      text: 't',
      html: 'h',
      headers: {},
    };
    await provider.send({ ...base, to: 'delivered@resend.dev' }, 'k1');
    await provider.send({ ...base, to: 'bounced+signup@resend.dev' }, 'k2');
    await provider.send({ ...base, to: 'complained@resend.dev' }, 'k3');
    await provider.send({ ...base, to: 'suppressed@resend.dev' }, 'k4');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.map((e) => e.type).sort()).toEqual([
      'email.bounced',
      'email.complained',
      'email.delivered',
      'email.delivered',
      'email.suppressed',
    ]);
  });
});
