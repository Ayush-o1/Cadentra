import express, { Router } from 'express';
import { Webhook } from 'svix';
import { z } from 'zod';
import type { Config } from '../../config/env.js';
import type { Db } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { recordProviderEvent } from './events.js';

const payloadSchema = z.object({
  type: z.string(),
  created_at: z.string().optional(),
  data: z.object({ email_id: z.string().optional() }).passthrough(),
});

/**
 * Receives Resend webhooks (delivered by Svix). The signature covers the exact bytes of the body, so
 * the route must read the raw body: re-serialising parsed JSON would break verification.
 */
export function createResendWebhookRouter(config: Config, db: Db): Router {
  const router = Router();
  const secret = config.email.resendWebhookSecret;

  router.post('/webhooks/resend', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    if (!secret) throw new AppError(404, 'NOT_FOUND', 'Route not found');

    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    let verified: unknown;
    try {
      verified = new Webhook(secret).verify(raw, {
        'svix-id': req.get('svix-id') ?? '',
        'svix-timestamp': req.get('svix-timestamp') ?? '',
        'svix-signature': req.get('svix-signature') ?? '',
      });
    } catch {
      throw new AppError(400, 'INVALID_SIGNATURE', 'The webhook signature could not be verified');
    }

    const payload = payloadSchema.parse(verified);
    const created = payload.created_at ? new Date(payload.created_at) : new Date();
    const outcome = await recordProviderEvent(db, {
      provider: 'resend',
      eventId: req.get('svix-id')!,
      type: payload.type,
      providerMessageId: payload.data.email_id ?? null,
      occurredAt: Number.isNaN(created.getTime()) ? new Date() : created,
      payload: { type: payload.type, email_id: payload.data.email_id ?? null },
    });
    res.status(200).json({ status: outcome });
  });

  return router;
}
