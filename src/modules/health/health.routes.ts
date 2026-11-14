import { Router } from 'express';

export function createHealthRouter(): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return router;
}
