import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { getAuth } from '../../middleware/auth.js';
import { createAnalyticsService } from './analytics.service.js';

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

const analyticsQuerySchema = z
  .object({
    range: z.enum(['7d', '30d', '90d']).default('30d'),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    campaignId: z.coerce.number().int().positive().optional(),
  })
  .refine((value) => (value.from === undefined) === (value.to === undefined), {
    message: 'Provide both from and to, or neither',
    path: ['from'],
  })
  .refine((value) => !value.from || !value.to || value.from < value.to, {
    message: 'The start must be before the end',
    path: ['from'],
  })
  .refine(
    (value) =>
      !value.from || !value.to || value.to.getTime() - value.from.getTime() <= MAX_RANGE_MS,
    {
      message: 'Choose a range of one year or less',
      path: ['to'],
    },
  );

export function createAnalyticsRouter(db: Db, requireAuth: RequestHandler): Router {
  const router = Router();
  const service = createAnalyticsService(db);

  router.get('/dashboard', requireAuth, async (req, res) => {
    res.json({ data: await service.dashboard(getAuth(req).workspaceId) });
  });

  router.get('/analytics', requireAuth, async (req, res) => {
    const query = analyticsQuerySchema.parse(req.query);
    res.json({ data: await service.analytics(getAuth(req).workspaceId, query) });
  });

  return router;
}
