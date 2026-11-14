import express, { Router, type RequestHandler } from 'express';
import type { Db } from '../../lib/db.js';
import { badRequest } from '../../lib/errors.js';
import { noContent, parseId } from '../../lib/http.js';
import { getAuth } from '../../middleware/auth.js';
import { importContacts } from './contacts.import.js';
import {
  createContactSchema,
  importQuerySchema,
  listContactsQuerySchema,
  updateContactSchema,
} from './contacts.schemas.js';
import { createContactsService } from './contacts.service.js';

export function createContactsRouter(db: Db, requireAuth: RequestHandler): Router {
  const router = Router();
  const service = createContactsService(db);
  router.use('/contacts', requireAuth);

  router.get('/contacts', async (req, res) => {
    const page = await service.list(
      getAuth(req).workspaceId,
      listContactsQuerySchema.parse(req.query),
    );
    res.json({ data: page.items, meta: { nextCursor: page.nextCursor } });
  });

  router.post('/contacts', async (req, res) => {
    const auth = getAuth(req);
    const contact = await service.create(
      auth.workspaceId,
      auth.userId,
      createContactSchema.parse(req.body),
    );
    res.status(201).json({ data: contact });
  });

  router.post(
    '/contacts/import',
    express.text({ type: 'text/csv', limit: '5mb' }),
    async (req, res) => {
      const auth = getAuth(req);
      const csv: unknown = req.body;
      if (typeof csv !== 'string' || csv.length === 0) {
        throw badRequest('Send the CSV file as the request body with Content-Type: text/csv');
      }
      const options = importQuerySchema.parse(req.query);
      const report = await importContacts(db, auth.workspaceId, auth.userId, csv, {
        consentBasis: options.consentBasis,
        source: options.source,
        listId: options.listId,
      });
      res.json({ data: report });
    },
  );

  router.get('/contacts/:id', async (req, res) => {
    res.json({
      data: await service.view(getAuth(req).workspaceId, parseId(req.params['id'], 'Contact')),
    });
  });

  router.patch('/contacts/:id', async (req, res) => {
    const auth = getAuth(req);
    const contact = await service.update(
      auth.workspaceId,
      auth.userId,
      parseId(req.params['id'], 'Contact'),
      updateContactSchema.parse(req.body),
    );
    res.json({ data: contact });
  });

  router.delete('/contacts/:id', async (req, res) => {
    const auth = getAuth(req);
    await service.remove(auth.workspaceId, auth.userId, parseId(req.params['id'], 'Contact'));
    noContent(res);
  });

  return router;
}
