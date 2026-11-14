import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { noContent, parseId } from '../../lib/http.js';
import { pageQuerySchema } from '../../lib/pagination.js';
import { emailSchema } from '../../lib/schemas.js';
import { getAuth } from '../../middleware/auth.js';
import { createSuppressionService } from './suppression.service.js';

const listQuerySchema = pageQuerySchema.extend({ search: z.string().trim().max(100).optional() });
const addSchema = z.object({ email: emailSchema });

export function createSuppressionRouter(db: Db, requireAuth: RequestHandler): Router {
  const router = Router();
  const service = createSuppressionService(db);
  router.use('/suppressions', requireAuth);

  router.get('/suppressions', async (req, res) => {
    const page = await service.list(getAuth(req).workspaceId, listQuerySchema.parse(req.query));
    res.json({ data: page.items, meta: { nextCursor: page.nextCursor } });
  });

  router.post('/suppressions', async (req, res) => {
    const auth = getAuth(req);
    const { email } = addSchema.parse(req.body);
    res.status(201).json({ data: await service.addManual(auth.workspaceId, auth.userId, email) });
  });

  router.delete('/suppressions/:id', async (req, res) => {
    const auth = getAuth(req);
    await service.remove(auth.workspaceId, auth.userId, parseId(req.params['id'], 'Suppression'));
    noContent(res);
  });

  return router;
}
