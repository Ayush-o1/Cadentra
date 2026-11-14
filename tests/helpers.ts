import type { Express } from 'express';
import request, { type Response } from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config/env.js';
import { createDb, type Db } from '../src/lib/db.js';
import { createLogger } from '../src/lib/logger.js';

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'mysql://cadentra:cadentra@127.0.0.1:3307/cadentra_test';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    APP_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    APP_URL: 'http://localhost:3000',
    RUN_WORKER: 'false',
    ...overrides,
  });
}

export function testLogger() {
  return createLogger({ env: 'test', logLevel: 'silent' });
}

export function testDb(): Db {
  return createDb(TEST_DATABASE_URL);
}

/** Removes all rows. Workspaces and users own everything else through cascading foreign keys. */
export async function resetDatabase(db: Db): Promise<void> {
  await db.webhookEvent.deleteMany();
  await db.workspace.deleteMany();
  await db.user.deleteMany();
}

export type ErrorBody = {
  code: string;
  message: string;
  details?: { path: string; message: string }[];
};

export function errorBody(res: Response): ErrorBody {
  return (res.body as { error: ErrorBody }).error;
}

export type TestApp = { app: Express; db: Db; config: Config };

export function buildTestApp(
  overrides: Record<string, string> = {},
  tweak?: (config: Config) => Config,
): TestApp {
  const baseConfig = testConfig(overrides);
  const config = tweak ? tweak(baseConfig) : baseConfig;
  const db = testDb();
  return { app: createApp({ config, logger: testLogger(), db }), db, config };
}

export type Credentials = { name: string; email: string; password: string };

let userCounter = 0;
export function newCredentials(): Credentials {
  userCounter += 1;
  return {
    name: `Test User ${userCounter}`,
    email: `user${userCounter}-${Date.now()}@example.org`,
    password: 'a-long-test-password',
  };
}

/** Registers a user through the API and returns a supertest agent that carries the session cookie. */
export async function registerAgent(app: Express, credentials = newCredentials()) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/register').send(credentials);
  if (res.status !== 201)
    throw new Error(`Registration failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, credentials, identity: (res.body as { data: Identity }).data };
}

export type Identity = {
  user: { id: number; email: string; name: string };
  workspace: { id: number; name: string; role: 'owner' | 'member' };
};
