import { Router, type RequestHandler } from 'express';
import type { Config } from '../../config/env.js';
import type { Db } from '../../lib/db.js';
import { getAuth, requireOwner } from '../../middleware/auth.js';
import { updateWorkspaceSchema } from './workspace.schemas.js';
import { createWorkspaceService } from './workspace.service.js';

export function createWorkspaceRouter(config: Config, db: Db, requireAuth: RequestHandler): Router {
  const router = Router();
  const service = createWorkspaceService(db, config);

  router.get('/workspace', requireAuth, async (req, res) => {
    const auth = getAuth(req);
    res.json({ data: await service.describe(auth.workspaceId, auth.role, auth.userId) });
  });

  router.patch('/workspace', requireAuth, requireOwner, async (req, res) => {
    const auth = getAuth(req);
    const input = updateWorkspaceSchema.parse(req.body);
    res.json({ data: await service.update(auth.workspaceId, auth.userId, input) });
  });

  return router;
}
