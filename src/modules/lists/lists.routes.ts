import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { noContent, parseId } from '../../lib/http.js';
import { getAuth } from '../../middleware/auth.js';
import { createListsService } from './lists.service.js';

const nameSchema = z.object({ name: z.string().trim().min(1, 'Enter a list name').max(120) });
const membersSchema = z.object({
  contactIds: z.array(z.number().int().positive()).min(1).max(1000),
});

export function createListsRouter(db: Db, requireAuth: RequestHandler): Router {
  const router = Router();
  const service = createListsService(db);
  router.use('/lists', requireAuth);

  router.get('/lists', async (req, res) => {
    res.json({ data: await service.list(getAuth(req).workspaceId) });
  });

  router.post('/lists', async (req, res) => {
    const auth = getAuth(req);
    const { name } = nameSchema.parse(req.body);
    res.status(201).json({ data: await service.create(auth.workspaceId, auth.userId, name) });
  });

  router.get('/lists/:id', async (req, res) => {
    res.json({
      data: await service.view(getAuth(req).workspaceId, parseId(req.params['id'], 'List')),
    });
  });

  router.patch('/lists/:id', async (req, res) => {
    const { name } = nameSchema.parse(req.body);
    res.json({
      data: await service.rename(getAuth(req).workspaceId, parseId(req.params['id'], 'List'), name),
    });
  });

  router.delete('/lists/:id', async (req, res) => {
    const auth = getAuth(req);
    await service.remove(auth.workspaceId, auth.userId, parseId(req.params['id'], 'List'));
    noContent(res);
  });

  router.post('/lists/:id/members', async (req, res) => {
    const { contactIds } = membersSchema.parse(req.body);
    const result = await service.addMembers(
      getAuth(req).workspaceId,
      parseId(req.params['id'], 'List'),
      contactIds,
    );
    res.json({ data: result });
  });

  router.delete('/lists/:id/members/:contactId', async (req, res) => {
    await service.removeMember(
      getAuth(req).workspaceId,
      parseId(req.params['id'], 'List'),
      parseId(req.params['contactId'], 'Contact'),
    );
    noContent(res);
  });

  return router;
}
