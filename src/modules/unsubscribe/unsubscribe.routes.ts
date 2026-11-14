import { Router } from 'express';
import type { Config } from '../../config/env.js';
import type { Db } from '../../lib/db.js';
import { createUnsubscribeService } from './unsubscribe.service.js';

const tokenOf = (value: unknown) => (typeof value === 'string' ? value : '');

/** JSON endpoints used by the unsubscribe page. Public: the signed token is the credential. */
export function createUnsubscribeApiRouter(config: Config, db: Db): Router {
  const router = Router();
  const service = createUnsubscribeService(db, config);

  router.get('/public/unsubscribe/:token', async (req, res) => {
    res.json({ data: await service.describe(tokenOf(req.params['token'])) });
  });

  router.post('/public/unsubscribe/:token', async (req, res) => {
    await service.unsubscribe(tokenOf(req.params['token']));
    res.json({ data: { unsubscribed: true } });
  });

  return router;
}

/**
 * RFC 8058 one-click unsubscribe. Mail clients POST `List-Unsubscribe=One-Click` straight to the
 * URL in the List-Unsubscribe header, with no cookies, Origin or confirmation step.
 */
export function createOneClickUnsubscribeRouter(config: Config, db: Db): Router {
  const router = Router();
  const service = createUnsubscribeService(db, config);

  router.post('/u/:token', async (req, res) => {
    await service.unsubscribe(tokenOf(req.params['token']));
    res.status(200).type('text/plain').send('Unsubscribed');
  });

  return router;
}
