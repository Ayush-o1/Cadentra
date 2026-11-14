import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Config } from './config/env.js';
import type { Db } from './lib/db.js';
import type { Logger } from './lib/logger.js';
import { createRequireAuth } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createHealthRouter } from './modules/health/health.routes.js';
import { createWorkspaceRouter } from './modules/workspace/workspace.routes.js';

export type AppDeps = {
  config: Config;
  logger: Logger;
  db: Db;
};

const publicDir = path.join(import.meta.dirname, 'public');

export function createApp({ config, logger, db }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    pinoHttp({
      logger,
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      genReqId: (req, res) => {
        const id = String(req.headers['x-request-id'] ?? randomUUID());
        res.setHeader('x-request-id', id);
        return id;
      },
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      strictTransportSecurity: config.isProduction,
    }),
  );

  app.use(createHealthRouter(db));

  const requireAuth = createRequireAuth(config, db);
  const api = Router();
  api.use(csrfProtection);
  api.use(createRateLimiter(config.rateLimits.api));
  api.use(express.json({ limit: '100kb' }));
  api.use(createAuthRouter(config, db));
  api.use(createWorkspaceRouter(config, db, requireAuth));
  app.use('/api/v1', api);

  app.use(express.static(publicDir, { index: 'index.html' }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
