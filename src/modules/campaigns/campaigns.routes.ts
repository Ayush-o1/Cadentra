import { Router, type RequestHandler } from 'express';
import type { Db } from '../../lib/db.js';
import { noContent, parseId } from '../../lib/http.js';
import { getAuth } from '../../middleware/auth.js';
import { createCampaignActions } from './campaigns.actions.js';
import {
  createCampaignSchema,
  launchSchema,
  listCampaignsQuerySchema,
  listMessagesQuerySchema,
  previewSchema,
  replaceStepsSchema,
  resumeSchema,
  updateCampaignSchema,
} from './campaigns.schemas.js';
import { createCampaignsService } from './campaigns.service.js';

export function createCampaignsRouter(
  db: Db,
  requireAuth: RequestHandler,
  options: { requireVerifiedEmail: boolean },
): Router {
  const router = Router();
  const service = createCampaignsService(db);
  const actions = createCampaignActions(db, service.detail, options);
  router.use('/campaigns', requireAuth);

  const campaignId = (value: unknown) => parseId(value, 'Campaign');

  router.get('/campaigns', async (req, res) => {
    const page = await service.list(
      getAuth(req).workspaceId,
      listCampaignsQuerySchema.parse(req.query),
    );
    res.json({ data: page.items, meta: { nextCursor: page.nextCursor } });
  });

  router.post('/campaigns', async (req, res) => {
    const auth = getAuth(req);
    const campaign = await service.create(
      auth.workspaceId,
      auth.userId,
      createCampaignSchema.parse(req.body),
    );
    res.status(201).json({ data: campaign });
  });

  router.get('/campaigns/:id', async (req, res) => {
    res.json({
      data: await service.detail(getAuth(req).workspaceId, campaignId(req.params['id'])),
    });
  });

  router.patch('/campaigns/:id', async (req, res) => {
    const auth = getAuth(req);
    const campaign = await service.update(
      auth.workspaceId,
      auth.userId,
      campaignId(req.params['id']),
      updateCampaignSchema.parse(req.body),
    );
    res.json({ data: campaign });
  });

  router.put('/campaigns/:id/steps', async (req, res) => {
    const auth = getAuth(req);
    const campaign = await service.replaceSteps(
      auth.workspaceId,
      auth.userId,
      campaignId(req.params['id']),
      replaceStepsSchema.parse(req.body),
    );
    res.json({ data: campaign });
  });

  router.delete('/campaigns/:id', async (req, res) => {
    const auth = getAuth(req);
    await service.remove(auth.workspaceId, auth.userId, campaignId(req.params['id']));
    noContent(res);
  });

  router.post('/campaigns/:id/preview', async (req, res) => {
    const { position, contactId } = previewSchema.parse(req.body);
    res.json({
      data: await service.preview(
        getAuth(req).workspaceId,
        campaignId(req.params['id']),
        position,
        contactId,
      ),
    });
  });

  router.get('/campaigns/:id/messages', async (req, res) => {
    const page = await service.messages(
      getAuth(req).workspaceId,
      campaignId(req.params['id']),
      listMessagesQuerySchema.parse(req.query),
    );
    res.json({ data: page.items, meta: { nextCursor: page.nextCursor } });
  });

  router.post('/campaigns/:id/launch', async (req, res) => {
    const auth = getAuth(req);
    const { version } = launchSchema.parse(req.body);
    res.json({
      data: await actions.launch(
        auth.workspaceId,
        auth.userId,
        campaignId(req.params['id']),
        version,
      ),
    });
  });

  router.post('/campaigns/:id/pause', async (req, res) => {
    const auth = getAuth(req);
    res.json({
      data: await actions.pause(auth.workspaceId, auth.userId, campaignId(req.params['id'])),
    });
  });

  router.post('/campaigns/:id/resume', async (req, res) => {
    const auth = getAuth(req);
    const { acknowledgeBounceRate } = resumeSchema.parse(req.body ?? {});
    res.json({
      data: await actions.resume(
        auth.workspaceId,
        auth.userId,
        campaignId(req.params['id']),
        acknowledgeBounceRate ?? false,
      ),
    });
  });

  router.post('/campaigns/:id/cancel', async (req, res) => {
    const auth = getAuth(req);
    res.json({
      data: await actions.cancel(auth.workspaceId, auth.userId, campaignId(req.params['id'])),
    });
  });

  return router;
}
