import { Router } from 'express';
import type { Db } from '../../lib/db.js';

export function createHealthRouter(db: Db): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/readyz', async (req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', database: 'up' });
    } catch (error) {
      req.log.error({ err: error }, 'Readiness check failed');
      res.status(503).json({ status: 'unavailable', database: 'down' });
    }
  });

  return router;
}
