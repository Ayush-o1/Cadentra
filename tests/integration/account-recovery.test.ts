import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/lib/crypto.js';
import {
  buildTestApp,
  errorBody,
  newCredentials,
  registerAgent,
  resetDatabase,
  type TestApp,
} from '../helpers.js';

const ctx = buildTestApp();
const { app, db, provider } = ctx;

beforeEach(async () => {
  await resetDatabase(db);
  provider.sent.length = 0;
});

afterAll(async () => {
  await db.$disconnect();
});

type Sent = TestApp['provider']['sent'][number];

/** System mail is sent after the response, so wait for it instead of assuming it is already out. */
async function nextEmailTo(address: string, subject: RegExp): Promise<Sent> {
  let found: Sent | undefined;
  await vi.waitFor(() => {
    found = provider.sent.find((s) => s.email.to === address && subject.test(s.email.subject));
    expect(found).toBeDefined();
  });
  return found!;
}

function tokenFrom(sent: Sent): string {
  const match = /#token=([\w-]+)/.exec(sent.email.text);
  if (!match) throw new Error(`No token link in: ${sent.email.text}`);
  return match[1]!;
}

const forgot = (email: string) => request(app).post('/api/v1/auth/forgot-password').send({ email });
const reset = (token: string, newPassword: string) =>
  request(app).post('/api/v1/auth/reset-password').send({ token, newPassword });

describe('password reset', () => {
  it('answers identically for a known and an unknown address, and only emails the known one', async () => {
    const credentials = newCredentials();
    await registerAgent(app, credentials);
    provider.sent.length = 0;

    const known = await forgot(credentials.email);
    const unknown = await forgot('nobody@example.org');
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual(known.body);

    await nextEmailTo(credentials.email, /Reset your Cadentra password/);
    expect(provider.sent.filter((s) => s.email.to === 'nobody@example.org')).toHaveLength(0);
  });

  it('puts the secret in the URL fragment and stores only its hash', async () => {
    const credentials = newCredentials();
    await registerAgent(app, credentials);
    await forgot(credentials.email);
    const sent = await nextEmailTo(credentials.email, /Reset your/);
    const token = tokenFrom(sent);

    expect(sent.email.text).toContain('http://localhost:3000/reset-password#token=');
    expect(sent.email.text).not.toContain('?token=');
    expect(sent.email.from).toBe('Cadentra <no-reply@cadentra.invalid>');
    const rows = await db.authToken.findMany({ where: { purpose: 'password_reset' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('sets the new password, signs out every session and spends the token', async () => {
    const credentials = newCredentials();
    const { agent: signedIn } = await registerAgent(app, credentials);
    await forgot(credentials.email);
    const token = tokenFrom(await nextEmailTo(credentials.email, /Reset your/));

    const newPassword = 'a-brand-new-password';
    expect((await reset(token, newPassword)).status).toBe(204);

    expect((await signedIn.get('/api/v1/auth/me')).status).toBe(401);
    const oldLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: credentials.email, password: credentials.password });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: credentials.email, password: newPassword });
    expect(newLogin.status).toBe(200);

    const again = await reset(token, 'yet-another-password');
    expect(again.status).toBe(400);
    expect(errorBody(again).code).toBe('INVALID_TOKEN');
  });

  it('refuses expired, unknown and wrong-purpose tokens', async () => {
    const credentials = newCredentials();
    await registerAgent(app, credentials);
    const verification = tokenFrom(await nextEmailTo(credentials.email, /Confirm your email/));
    await forgot(credentials.email);
    const token = tokenFrom(await nextEmailTo(credentials.email, /Reset your/));

    const unknown = await reset('x'.repeat(43), 'a-brand-new-password');
    expect(errorBody(unknown).code).toBe('INVALID_TOKEN');
    expect(errorBody(await reset(verification, 'a-brand-new-password')).code).toBe('INVALID_TOKEN');

    await db.authToken.updateMany({
      where: { purpose: 'password_reset' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(errorBody(await reset(token, 'a-brand-new-password')).code).toBe('INVALID_TOKEN');
  });

  it('keeps the token usable after a too-weak password is rejected', async () => {
    const credentials = newCredentials();
    await registerAgent(app, credentials);
    await forgot(credentials.email);
    const token = tokenFrom(await nextEmailTo(credentials.email, /Reset your/));

    expect((await reset(token, 'short')).status).toBe(422);
    expect((await reset(token, 'a-long-enough-password')).status).toBe(204);
  });

  it('invalidates the earlier link when another is requested', async () => {
    const credentials = newCredentials();
    await registerAgent(app, credentials);
    await forgot(credentials.email);
    const first = tokenFrom(await nextEmailTo(credentials.email, /Reset your/));
    provider.sent.length = 0;
    await forgot(credentials.email);
    const second = tokenFrom(await nextEmailTo(credentials.email, /Reset your/));

    expect(second).not.toBe(first);
    expect(errorBody(await reset(first, 'a-brand-new-password')).code).toBe('INVALID_TOKEN');
    expect((await reset(second, 'a-brand-new-password')).status).toBe(204);
  });

  it('lets only one of two simultaneous uses of a link succeed', async () => {
    const credentials = newCredentials();
    await registerAgent(app, credentials);
    await forgot(credentials.email);
    const token = tokenFrom(await nextEmailTo(credentials.email, /Reset your/));

    const results = await Promise.all([
      reset(token, 'first-new-password-1'),
      reset(token, 'second-new-password-2'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 400]);
  });

  it('counts the reset as proof of the mailbox', async () => {
    const credentials = newCredentials();
    await registerAgent(app, credentials);
    await forgot(credentials.email);
    const token = tokenFrom(await nextEmailTo(credentials.email, /Reset your/));
    await reset(token, 'a-brand-new-password');
    const user = await db.user.findUniqueOrThrow({ where: { email: credentials.email } });
    expect(user.emailVerifiedAt).not.toBeNull();
  });

  it('is rate limited per account', async () => {
    const limited = buildTestApp({}, (config) => ({
      ...config,
      rateLimits: {
        ...config.rateLimits,
        passwordResetPerAccount: { windowMs: 60_000, limit: 2 },
      },
    }));
    const send = () =>
      request(limited.app).post('/api/v1/auth/forgot-password').send({ email: 'a@example.org' });
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(429);
    await limited.db.$disconnect();
  });

  it('keeps going when the mail provider fails', async () => {
    const credentials = newCredentials();
    await registerAgent(app, credentials);
    provider.failNext(
      new (await import('../../src/email/provider.js')).ProviderError('down', true),
    );
    const res = await forgot(credentials.email);
    expect(res.status).toBe(202);
  });
});

describe('email verification', () => {
  it('sends a link at registration and verifies the address with it', async () => {
    const credentials = newCredentials();
    const { agent, identity } = await registerAgent(app, credentials);
    expect(identity.user).toMatchObject({ emailVerified: false });

    const token = tokenFrom(await nextEmailTo(credentials.email, /Confirm your email/));
    expect((await request(app).post('/api/v1/auth/verify-email').send({ token })).status).toBe(204);

    const me = await agent.get('/api/v1/auth/me');
    expect(
      (me.body as { data: { user: { emailVerified: boolean } } }).data.user.emailVerified,
    ).toBe(true);
    const again = await request(app).post('/api/v1/auth/verify-email').send({ token });
    expect(errorBody(again).code).toBe('INVALID_TOKEN');
  });

  it('can send a fresh link, but not once verified, and requires sign-in', async () => {
    expect((await request(app).post('/api/v1/account/verification-email')).status).toBe(401);

    const credentials = newCredentials();
    const { agent } = await registerAgent(app, credentials);
    await nextEmailTo(credentials.email, /Confirm your email/);
    provider.sent.length = 0;

    const resent = await agent.post('/api/v1/account/verification-email');
    expect(resent.status).toBe(202);
    expect((resent.body as { data: { sent: boolean } }).data.sent).toBe(true);
    const token = tokenFrom(await nextEmailTo(credentials.email, /Confirm your email/));
    await request(app).post('/api/v1/auth/verify-email').send({ token });

    const after = await agent.post('/api/v1/account/verification-email');
    expect((after.body as { data: { sent: boolean } }).data.sent).toBe(false);
  });

  it('does not send a verification email for the wrong purpose of token', async () => {
    const credentials = newCredentials();
    await registerAgent(app, credentials);
    await forgot(credentials.email);
    const resetToken = tokenFrom(await nextEmailTo(credentials.email, /Reset your/));
    const res = await request(app).post('/api/v1/auth/verify-email').send({ token: resetToken });
    expect(errorBody(res).code).toBe('INVALID_TOKEN');
  });
});

describe('requiring a verified email to launch', () => {
  const strict = buildTestApp({ REQUIRE_VERIFIED_EMAIL: 'true' });

  it('lists the requirement as a launch blocker until the address is confirmed', async () => {
    const credentials = newCredentials();
    const { agent } = await registerAgent(strict.app, credentials);
    const blockers = async () =>
      ((await agent.get('/api/v1/workspace')).body as { data: { launchBlockers: string[] } }).data
        .launchBlockers;

    expect((await blockers()).join(' ')).toContain('Confirm your email address');

    const list = (await agent.post('/api/v1/lists').send({ name: 'L' })).body as {
      data: { id: number };
    };
    const campaign = (
      await agent.post('/api/v1/campaigns').send({ name: 'C', listId: list.data.id })
    ).body as { data: { id: number; version: number } };
    const launch = await agent
      .post(`/api/v1/campaigns/${campaign.data.id}/launch`)
      .send({ version: campaign.data.version });
    expect(launch.status).toBe(422);
    expect(JSON.stringify(launch.body)).toContain('Confirm your email address');

    await strict.db.user.updateMany({ data: { emailVerifiedAt: new Date() } });
    expect((await blockers()).join(' ')).not.toContain('Confirm your email address');
    await strict.db.$disconnect();
  });
});
