import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Config } from './config/env.js';
import type { EmailProvider } from './email/provider.js';
import { createSystemMailer } from './email/system-mail.js';
import type { Db } from './lib/db.js';
import type { Logger } from './lib/logger.js';
import type { Worker } from './worker/worker.js';
import { createRequireAuth } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { createAnalyticsRouter } from './modules/analytics/analytics.routes.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createCampaignsRouter } from './modules/campaigns/campaigns.routes.js';
import { createContactsRouter } from './modules/contacts/contacts.routes.js';
import { createHealthRouter } from './modules/health/health.routes.js';
import { createTickRouter } from './modules/internal/tick.routes.js';
import { createListsRouter } from './modules/lists/lists.routes.js';
import {
  createOneClickUnsubscribeRouter,
  createUnsubscribeApiRouter,
} from './modules/unsubscribe/unsubscribe.routes.js';
import { createResendWebhookRouter } from './modules/webhooks/resend.routes.js';
import { createSuppressionRouter } from './modules/suppression/suppression.routes.js';
import { createWorkspaceRouter } from './modules/workspace/workspace.routes.js';

export type AppDeps = {
  config: Config;
  logger: Logger;
  db: Db;
  provider: EmailProvider;
  worker?: Worker;
};

const publicDir = path.join(import.meta.dirname, 'public');

export function createApp({ config, logger, db, provider, worker }: AppDeps): Express {
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
          // Unsubscribe tokens are credentials for one address; keep them out of the logs.
          url: req.url.replace(/(\/(?:u|public\/unsubscribe)\/)[^/?#]+/, '$1[token]'),
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

  app.use((_req, res, next) => {
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    next();
  });
  app.use(createHealthRouter(db));
  // These routes read their own raw bodies or take no cookies, so they sit outside the JSON API.
  app.use(createResendWebhookRouter(config, db));
  app.use('/u', createRateLimiter(config.rateLimits.api));
  app.use(createOneClickUnsubscribeRouter(config, db));
  if (worker) app.use(createTickRouter(config, worker));

  const requireAuth = createRequireAuth(config, db);
  const api = Router();
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(csrfProtection);
  api.use(createRateLimiter(config.rateLimits.api));
  api.use(express.json({ limit: '100kb' }));
  api.use(createUnsubscribeApiRouter(config, db));
  api.use(createAuthRouter(config, db, createSystemMailer(provider, config, logger)));
  api.use(createWorkspaceRouter(config, db, requireAuth));
  api.use(createContactsRouter(db, requireAuth));
  api.use(createListsRouter(db, requireAuth));
  api.use(createSuppressionRouter(db, requireAuth));
  api.use(
    createCampaignsRouter(db, requireAuth, {
      requireVerifiedEmail: config.auth.requireVerifiedEmail,
    }),
  );
  api.use(createAnalyticsRouter(db, requireAuth));
  app.use('/api/v1', api);

  app.use(
    express.static(publicDir, {
      index: 'index.html',
      setHeaders: (res, filePath) => {
        // Fonts never change under the same name; everything else is revalidated by ETag.
        if (filePath.includes(`${path.sep}fonts${path.sep}`)) {
          res.set('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  app.get('/{*path}', (req, res, next) => {
    const wantsPage = req.get('accept')?.includes('text/html') ?? false;
    const isPage = wantsPage && !req.path.startsWith('/api/');
    if (isPage) res.sendFile(path.join(publicDir, 'index.html'));
    else next();
  });
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
