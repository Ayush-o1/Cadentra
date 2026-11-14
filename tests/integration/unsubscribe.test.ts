import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/email/fake.provider.js';
import { createUnsubscribeToken } from '../../src/modules/unsubscribe/unsubscribe.token.js';
import { buildTestApp, errorBody, resetDatabase } from '../helpers.js';
import { launchScenario, makeAllDue, workerFor } from '../scenario.js';

const ctx = buildTestApp();
const { app, db, config } = ctx;

beforeEach(async () => {
  await resetDatabase(db);
});

afterAll(async () => {
  await db.$disconnect();
});

async function sentMessage() {
  const scenario = await launchScenario(app, { contacts: 2 });
  const provider = new FakeProvider();
  const worker = workerFor(ctx, provider);
  await worker.runOnce();
  const mail = provider.sent[0]!.email;
  const url = /Unsubscribe: (\S+)/.exec(mail.text)![1]!;
  return { ...scenario, provider, worker, mail, token: url.split('/u/')[1]!, to: mail.to };
}

describe('unsubscribe page data', () => {
  it('shows a masked address and the sender without logging in', async () => {
    const { token } = await sentMessage();
    const res = await request(app).get(`/api/v1/public/unsubscribe/${token}`);
    expect(res.status).toBe(200);
    const data = (
      res.body as { data: { email: string; sender: string; alreadyUnsubscribed: boolean } }
    ).data;
    expect(data.sender).toBe('Priya at Northwind');
    expect(data.email).toMatch(/^l•+@example\.org$/);
    expect(data.alreadyUnsubscribed).toBe(false);
  });

  it('refuses tampered, malformed and unknown links', async () => {
    const { token } = await sentMessage();
    const forged = token.replace(/\.[\w-]+$/, '.forgedsignature');
    const unknown = createUnsubscribeToken(config.appSecret, 999_999);
    for (const bad of [forged, 'garbage', unknown]) {
      const res = await request(app).get(`/api/v1/public/unsubscribe/${bad}`);
      expect(res.status, bad).toBe(404);
      expect((await request(app).post(`/api/v1/public/unsubscribe/${bad}`)).status, bad).toBe(404);
    }
    expect(await db.suppression.count()).toBe(0);
  });

  it('serves the page itself for the link in the email', async () => {
    const { token } = await sentMessage();
    const res = await request(app).get(`/u/${token}`).set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});

describe('unsubscribing', () => {
  it('suppresses the address, logs it and is safe to repeat', async () => {
    const { token, to, workspaceId } = await sentMessage();
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post(`/api/v1/public/unsubscribe/${token}`);
      expect(res.status).toBe(200);
    }
    const suppressions = await db.suppression.findMany();
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]).toMatchObject({ email: to, reason: 'unsubscribed', workspaceId });
    expect(await db.activityLog.count({ where: { action: 'contact.unsubscribed' } })).toBe(1);

    const page = await request(app).get(`/api/v1/public/unsubscribe/${token}`);
    expect((page.body as { data: { alreadyUnsubscribed: boolean } }).data.alreadyUnsubscribed).toBe(
      true,
    );
  });

  it('works as a one-click POST from a mail client with no cookies, Origin or JSON', async () => {
    const { token, to } = await sentMessage();
    const res = await request(app)
      .post(`/u/${token}`)
      .type('form')
      .send('List-Unsubscribe=One-Click');
    expect(res.status).toBe(200);
    expect((await db.suppression.findFirstOrThrow()).email).toBe(to);
  });

  it('cancels the rest of the sequence for that person only', async () => {
    const { token, to, campaignId, provider, worker } = await sentMessage();
    await request(app).post(`/api/v1/public/unsubscribe/${token}`);

    await makeAllDue(ctx, campaignId);
    await worker.runOnce();

    const stepTwoMail = provider.sent.slice(2);
    expect(stepTwoMail).toHaveLength(1);
    expect(stepTwoMail[0]!.email.to).not.toBe(to);
    expect(
      await db.emailMessage.count({ where: { campaignId, toEmail: to, status: 'skipped' } }),
    ).toBe(1);
  });

  it('keeps the person suppressed even if their contact record is deleted and re-created', async () => {
    const { token, to, agent, workspaceId } = await sentMessage();
    await request(app).post(`/api/v1/public/unsubscribe/${token}`);

    const contact = await db.contact.findFirstOrThrow({ where: { workspaceId, email: to } });
    expect((await agent.delete(`/api/v1/contacts/${contact.id}`)).status).toBe(204);
    const recreated = await agent
      .post('/api/v1/contacts')
      .send({ email: to, consentBasis: 'signed_up' });
    expect(recreated.status).toBe(201);
    expect((recreated.body as { data: { suppressionReason: string } }).data.suppressionReason).toBe(
      'unsubscribed',
    );
  });

  it('rejects unsubscribes that use the cookie-authenticated API incorrectly', async () => {
    const res = await request(app)
      .post('/api/v1/public/unsubscribe/x')
      .set('Origin', 'https://evil.example');
    expect(errorBody(res).code).toBe('CSRF_REJECTED');
  });
});
