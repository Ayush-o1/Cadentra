import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/lib/crypto.js';
import {
  buildTestApp,
  errorBody,
  newCredentials,
  registerAgent,
  resetDatabase,
} from '../helpers.js';

const { app, db, config } = buildTestApp();

beforeEach(async () => {
  await resetDatabase(db);
});

afterAll(async () => {
  await db.$disconnect();
});

function setCookies(res: request.Response): string[] {
  const header = res.headers['set-cookie'] as string | string[] | undefined;
  return Array.isArray(header) ? header : header ? [header] : [];
}

describe('registration', () => {
  it('creates the user, workspace and owner membership and signs the user in', async () => {
    const credentials = newCredentials();
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/register').send(credentials);

    expect(res.status).toBe(201);
    const identity = (
      res.body as { data: { user: { email: string }; workspace: { role: string } } }
    ).data;
    expect(identity.user.email).toBe(credentials.email);
    expect(identity.workspace.role).toBe('owner');

    const user = await db.user.findUniqueOrThrow({
      where: { email: credentials.email },
      include: { memberships: true },
    });
    expect(user.memberships).toHaveLength(1);
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(credentials.password);

    expect((await agent.get('/api/v1/auth/me')).status).toBe(200);
    expect(await db.activityLog.count({ where: { action: 'workspace.created' } })).toBe(1);
  });

  it('normalises the email address', async () => {
    const credentials = newCredentials();
    await registerAgent(app, { ...credentials, email: `  ${credentials.email.toUpperCase()} ` });
    const user = await db.user.findFirstOrThrow();
    expect(user.email).toBe(credentials.email);
  });

  it('sets a hardened session cookie and stores only the token hash', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(newCredentials());
    const cookie = setCookies(res).find((value) => value.startsWith('cadentra_sid='));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);

    const token = decodeURIComponent(cookie!.split(';')[0]!.split('=')[1]!);
    const session = await db.session.findFirstOrThrow();
    expect(session.tokenHash).toBe(sha256Hex(token));
    expect(session.tokenHash).not.toBe(token);
  });

  it('uses the __Host- prefix and Secure flag over https', async () => {
    const secure = buildTestApp({ APP_URL: 'https://app.example.org' });
    const res = await request(secure.app)
      .post('/api/v1/auth/register')
      .set('Host', 'app.example.org')
      .send(newCredentials());
    await secure.db.$disconnect();
    const cookie = setCookies(res).find((value) => value.startsWith('__Host-cadentra_sid='));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/Secure/i);
  });

  it('rejects a duplicate email', async () => {
    const credentials = newCredentials();
    await registerAgent(app, credentials);
    const res = await request(app).post('/api/v1/auth/register').send(credentials);
    expect(res.status).toBe(409);
    expect(errorBody(res).code).toBe('EMAIL_TAKEN');
  });

  it('validates the input and reports each field', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: '', email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(422);
    const paths = errorBody(res)
      .details?.map((detail) => detail.path)
      .sort();
    expect(paths).toEqual(['email', 'name', 'password']);
  });

  it('rolls back the account when the workspace cannot be created', async () => {
    const credentials = newCredentials();
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...credentials, workspaceName: 'x'.repeat(500) });
    expect(res.status).toBe(422);
    expect(await db.user.count()).toBe(0);
  });
});

describe('login and logout', () => {
  it('signs in with the right password', async () => {
    const { credentials } = await registerAgent(app);
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: credentials.email.toUpperCase(), password: credentials.password });
    expect(res.status).toBe(200);
    expect(setCookies(res).some((value) => value.startsWith('cadentra_sid='))).toBe(true);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const { credentials } = await registerAgent(app);
    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: credentials.email, password: 'definitely-wrong-password' });
    const unknownUser = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.org', password: 'definitely-wrong-password' });
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownUser.body);
  });

  it('ends the session on logout and clears the cookie', async () => {
    const { agent } = await registerAgent(app);
    const res = await agent.post('/api/v1/auth/logout');
    expect(res.status).toBe(204);
    expect(setCookies(res).some((value) => /cadentra_sid=;/.test(value))).toBe(true);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
    expect(await db.session.count()).toBe(0);
  });

  it('throttles repeated failures against one account', async () => {
    const limited = buildTestApp({}, (base) => ({
      ...base,
      rateLimits: { ...base.rateLimits, loginPerAccount: { windowMs: 60_000, limit: 3 } },
    }));
    const { credentials } = await registerAgent(limited.app);
    const attempt = (password: string) =>
      request(limited.app).post('/api/v1/auth/login').send({ email: credentials.email, password });

    for (let i = 0; i < 3; i++) expect((await attempt('wrong-password-here')).status).toBe(401);
    const blocked = await attempt(credentials.password);
    await limited.db.$disconnect();
    expect(blocked.status).toBe(429);
    expect(errorBody(blocked).code).toBe('RATE_LIMITED');
  });
});

describe('session probe', () => {
  it('answers 200 with null when signed out, so page loads never log an error', async () => {
    const res = await request(app).get('/api/v1/auth/session');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: null });
    const garbage = await request(app)
      .get('/api/v1/auth/session')
      .set('Cookie', 'cadentra_sid=garbage');
    expect(garbage.body).toEqual({ data: null });
  });

  it('returns the identity for a valid session', async () => {
    const { agent, credentials } = await registerAgent(app);
    const res = await agent.get('/api/v1/auth/session');
    expect((res.body as { data: { user: { email: string } } }).data.user.email).toBe(
      credentials.email,
    );
  });
});

describe('session validation', () => {
  it('requires authentication for protected routes', async () => {
    for (const path of ['/api/v1/auth/me', '/api/v1/workspace', '/api/v1/account/sessions']) {
      expect((await request(app).get(path)).status).toBe(401);
    }
    const garbage = await request(app).get('/api/v1/auth/me').set('Cookie', 'cadentra_sid=garbage');
    expect(garbage.status).toBe(401);
  });

  it('rejects an expired session', async () => {
    const { agent } = await registerAgent(app);
    await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('rejects a session that has been idle too long', async () => {
    const { agent } = await registerAgent(app);
    await db.session.updateMany({
      data: { lastSeenAt: new Date(Date.now() - config.session.idleTimeoutMs - 1000) },
    });
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });
});

describe('account management', () => {
  it('updates the profile name', async () => {
    const { agent } = await registerAgent(app);
    const res = await agent.patch('/api/v1/account/profile').send({ name: 'Renamed Person' });
    expect(res.status).toBe(200);
    expect((res.body as { data: { user: { name: string } } }).data.user.name).toBe(
      'Renamed Person',
    );
  });

  it('changes the password, keeps this session and signs out the others', async () => {
    const { agent, credentials } = await registerAgent(app);
    const otherDevice = request.agent(app);
    await otherDevice
      .post('/api/v1/auth/login')
      .send({ email: credentials.email, password: credentials.password });
    expect((await otherDevice.get('/api/v1/auth/me')).status).toBe(200);

    const wrongCurrent = await agent
      .post('/api/v1/account/password')
      .send({ currentPassword: 'not-the-password', newPassword: 'another-long-password' });
    expect(wrongCurrent.status).toBe(422);

    const changed = await agent
      .post('/api/v1/account/password')
      .send({ currentPassword: credentials.password, newPassword: 'another-long-password' });
    expect(changed.status).toBe(204);

    expect((await agent.get('/api/v1/auth/me')).status).toBe(200);
    expect((await otherDevice.get('/api/v1/auth/me')).status).toBe(401);
    const oldLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: credentials.email, password: credentials.password });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: credentials.email, password: 'another-long-password' });
    expect(newLogin.status).toBe(200);
  });

  it('lists sessions, flags the current one, and revokes only the owner own sessions', async () => {
    const { agent, credentials } = await registerAgent(app);
    const other = request.agent(app);
    await other
      .post('/api/v1/auth/login')
      .send({ email: credentials.email, password: credentials.password });
    const stranger = await registerAgent(app);

    const list = (await agent.get('/api/v1/account/sessions')).body as {
      data: { id: number; current: boolean }[];
    };
    expect(list.data).toHaveLength(2);
    const other_ = list.data.find((session) => !session.current)!;
    expect(list.data.filter((session) => session.current)).toHaveLength(1);

    expect((await stranger.agent.delete(`/api/v1/account/sessions/${other_.id}`)).status).toBe(404);
    expect((await agent.delete(`/api/v1/account/sessions/${other_.id}`)).status).toBe(204);
    expect((await other.get('/api/v1/auth/me')).status).toBe(401);
  });
});

describe('cross-site request protection', () => {
  it('rejects writes from a foreign origin', async () => {
    const { agent } = await registerAgent(app);
    const res = await agent
      .patch('/api/v1/account/profile')
      .set('Origin', 'https://evil.example')
      .send({ name: 'Hacked' });
    expect(res.status).toBe(403);
    expect(errorBody(res).code).toBe('CSRF_REJECTED');
  });

  it('rejects writes flagged cross-site by the browser', async () => {
    const { agent } = await registerAgent(app);
    const res = await agent
      .patch('/api/v1/account/profile')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ name: 'Hacked' });
    expect(res.status).toBe(403);
  });

  it('accepts writes from the same origin', async () => {
    const { agent } = await registerAgent(app);
    const res = await agent
      .patch('/api/v1/account/profile')
      .set('Host', 'app.test')
      .set('Origin', 'http://app.test')
      .send({ name: 'Same Origin' });
    expect(res.status).toBe(200);
  });

  it('rejects a body that is not JSON, as an HTML form would send', async () => {
    const { agent } = await registerAgent(app);
    const res = await agent.patch('/api/v1/account/profile').type('form').send('name=Hacked');
    expect(res.status).toBe(415);
  });
});

describe('workspace settings', () => {
  it('shows what blocks launching until the sender identity is complete', async () => {
    const { agent } = await registerAgent(app);
    const before = (await agent.get('/api/v1/workspace')).body as {
      data: { launchBlockers: string[] };
    };
    expect(before.data.launchBlockers).toHaveLength(3);

    const res = await agent.patch('/api/v1/workspace').send({
      senderName: 'Priya at Northwind',
      senderEmail: 'priya@northwind.example',
      postalAddress: '12 Harbour Road, Bristol BS1 4AA, United Kingdom',
      timezone: 'Europe/London',
    });
    expect(res.status).toBe(200);
    expect((res.body as { data: { launchBlockers: string[] } }).data.launchBlockers).toEqual([]);
  });

  it('validates time zones, windows and limits', async () => {
    const { agent } = await registerAgent(app);
    expect((await agent.patch('/api/v1/workspace').send({ timezone: 'Mars/Olympus' })).status).toBe(
      422,
    );
    expect(
      (await agent.patch('/api/v1/workspace').send({ windowStartHour: 18, windowEndHour: 9 }))
        .status,
    ).toBe(422);
    expect((await agent.patch('/api/v1/workspace').send({ dailySendLimit: 0 })).status).toBe(422);
  });

  it('refuses changes from a non-owner member', async () => {
    const { agent, identity } = await registerAgent(app);
    await db.workspaceMember.updateMany({
      where: { workspaceId: identity.workspace.id },
      data: { role: 'member' },
    });
    const res = await agent.patch('/api/v1/workspace').send({ name: 'Takeover' });
    expect(res.status).toBe(403);
  });
});
