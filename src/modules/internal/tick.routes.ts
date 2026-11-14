import { Router } from 'express';
import type { Config } from '../../config/env.js';
import { safeEqual } from '../../lib/crypto.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import type { Worker } from '../../worker/worker.js';

/**
 * Lets an external scheduler drive the worker on hosts that put idle processes to sleep: one
 * authenticated POST processes everything that is due. Disabled unless TICK_TOKEN is set.
 */
export function createTickRouter(config: Config, worker: Worker): Router {
  const router = Router();
  const token = config.worker.tickToken;

  router.post('/internal/tick', async (req, res) => {
    if (!token) throw new AppError(404, 'NOT_FOUND', 'Route not found');
    const header = req.get('authorization') ?? '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!safeEqual(supplied, token)) throw unauthorized('Invalid tick token');
    res.json({ data: await worker.runOnce() });
  });

  return router;
}
