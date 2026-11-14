import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { FakeProvider } from '../../src/email/fake.provider.js';
import { AppError, conflict, validationFailed } from '../../src/lib/errors.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { errorBody, testConfig, testDb, testLogger } from '../helpers.js';

describe('app foundation', () => {
  const db = testDb();
  const app = createApp({
    config: testConfig(),
    logger: testLogger(),
    db,
    provider: new FakeProvider(),
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('answers the liveness probe', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('reports readiness once the database answers', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'up' });
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(errorBody(res).code).toBe('NOT_FOUND');
  });

  it('serves the frontend with a strict content security policy', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('error handler', () => {
  function appThatThrows(error: unknown) {
    const app = express();
    app.use((req, _res, next) => {
      req.log = { error: () => undefined } as never;
      next();
    });
    app.get('/boom', () => {
      throw error;
    });
    app.get('/async-boom', async () => {
      await Promise.resolve();
      throw error;
    });
    app.use(errorHandler);
    return app;
  }

  it('maps AppError to its status and code', async () => {
    const res = await request(appThatThrows(conflict('Already exists', 'DUPLICATE'))).get('/boom');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'DUPLICATE', message: 'Already exists' } });
  });

  it('includes validation details', async () => {
    const error = validationFailed('Bad input', [{ path: 'email', message: 'Invalid email' }]);
    const res = await request(appThatThrows(error)).get('/boom');
    expect(res.status).toBe(422);
    expect(errorBody(res).details).toEqual([{ path: 'email', message: 'Invalid email' }]);
  });

  it('forwards errors thrown inside async handlers (Express 5)', async () => {
    const res = await request(appThatThrows(new AppError(403, 'FORBIDDEN', 'Nope'))).get(
      '/async-boom',
    );
    expect(res.status).toBe(403);
  });

  it('hides internal details for unexpected errors', async () => {
    const res = await request(appThatThrows(new Error('database password is hunter2'))).get(
      '/boom',
    );
    expect(res.status).toBe(500);
    expect(errorBody(res).code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });
});
