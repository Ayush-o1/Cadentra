import type { Config } from '../../config/env.js';
import type { Db } from '../../lib/db.js';
import { notFound } from '../../lib/errors.js';
import { recordActivity } from '../activity/activity.service.js';
import { suppressEmail } from '../suppression/suppression.service.js';
import { readUnsubscribeToken } from './unsubscribe.token.js';

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

export function createUnsubscribeService(db: Db, config: Config) {
  async function messageFor(token: string) {
    const messageId = readUnsubscribeToken(config.appSecret, token);
    if (messageId === null) throw notFound('Unsubscribe link');
    const message = await db.emailMessage.findUnique({
      where: { id: messageId },
      select: { id: true, workspaceId: true, toEmail: true },
    });
    if (!message) throw notFound('Unsubscribe link');
    return message;
  }

  return {
    async describe(token: string) {
      const message = await messageFor(token);
      const [workspace, suppression] = await Promise.all([
        db.workspace.findUniqueOrThrow({
          where: { id: message.workspaceId },
          select: { senderName: true, name: true },
        }),
        db.suppression.findUnique({
          where: {
            workspaceId_email: { workspaceId: message.workspaceId, email: message.toEmail },
          },
        }),
      ]);
      return {
        email: maskEmail(message.toEmail),
        sender: workspace.senderName ?? workspace.name,
        alreadyUnsubscribed: suppression !== null,
      };
    },

    /** Idempotent: following the link twice, or a mail client posting it, has the same effect. */
    async unsubscribe(token: string): Promise<void> {
      const message = await messageFor(token);
      await db.$transaction(async (tx) => {
        const added = await suppressEmail(tx, {
          workspaceId: message.workspaceId,
          email: message.toEmail,
          reason: 'unsubscribed',
          sourceMessageId: message.id,
        });
        if (added) {
          await recordActivity(tx, {
            workspaceId: message.workspaceId,
            action: 'contact.unsubscribed',
            entityType: 'message',
            entityId: message.id,
            metadata: { email: message.toEmail },
          });
        }
      });
    },
  };
}
