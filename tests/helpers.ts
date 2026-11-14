import type { Response } from 'supertest';
import { loadConfig, type Config } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'mysql://cadentra:cadentra@127.0.0.1:3307/cadentra_test',
    APP_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    APP_URL: 'http://localhost:3000',
    RUN_WORKER: 'false',
    ...overrides,
  });
}

export function testLogger() {
  return createLogger({ env: 'test', logLevel: 'silent' });
}

export type ErrorBody = {
  code: string;
  message: string;
  details?: { path: string; message: string }[];
};

export function errorBody(res: Response): ErrorBody {
  return (res.body as { error: ErrorBody }).error;
}
