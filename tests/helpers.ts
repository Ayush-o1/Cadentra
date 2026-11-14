import type { Response } from 'supertest';
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
