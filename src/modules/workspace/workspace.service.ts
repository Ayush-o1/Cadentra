import type { Config } from '../../config/env.js';
import type { Workspace } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { validationFailed } from '../../lib/errors.js';
import { recordActivity } from '../activity/activity.service.js';
import type { UpdateWorkspaceInput } from './workspace.schemas.js';

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** What must be configured before a campaign may launch. */
export function launchBlockers(
  workspace: Pick<Workspace, 'senderName' | 'senderEmail' | 'postalAddress'>,
): string[] {
  const blockers: string[] = [];
  if (!workspace.senderName) blockers.push('Add a sender name in Settings');
  if (!workspace.senderEmail) blockers.push('Add a sender email address in Settings');
  if (!workspace.postalAddress) blockers.push('Add a postal address in Settings');
  return blockers;
}

/** Account-level reasons a campaign may not launch, when the deployment asks for a verified email. */
export function accountBlockers(
  user: { emailVerifiedAt: Date | null },
  requireVerifiedEmail: boolean,
): string[] {
  return requireVerifiedEmail && !user.emailVerifiedAt
    ? ['Confirm your email address (use the link we sent, or send a new one from Settings)']
    : [];
}

export function createWorkspaceService(db: Db, config: Config) {
  async function describe(workspaceId: number, role: 'owner' | 'member', userId: number) {
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const sentToday = await db.emailMessage.count({
      where: { workspaceId, acceptedAt: { gte: startOfUtcDay(new Date()) } },
    });
    return {
      id: workspace.id,
      name: workspace.name,
      role,
      timezone: workspace.timezone,
      senderName: workspace.senderName,
      senderEmail: workspace.senderEmail,
      replyToEmail: workspace.replyToEmail,
      postalAddress: workspace.postalAddress,
      windowStartHour: workspace.windowStartHour,
      windowEndHour: workspace.windowEndHour,
      weekdaysOnly: workspace.weekdaysOnly,
      dailySendLimit: workspace.dailySendLimit,
      sentToday,
      launchBlockers: [
        ...accountBlockers(user, config.auth.requireVerifiedEmail),
        ...launchBlockers(workspace),
      ],
      provider: {
        name: config.email.provider,
        simulated: config.email.provider === 'fake',
      },
    };
  }

  return {
    describe,

    async update(workspaceId: number, userId: number, input: UpdateWorkspaceInput) {
      const current = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
      const start = input.windowStartHour ?? current.windowStartHour;
      const end = input.windowEndHour ?? current.windowEndHour;
      if (start >= end) {
        throw validationFailed('The sending window must end after it starts', [
          { path: 'windowEndHour', message: 'The sending window must end after it starts' },
        ]);
      }
      await db.workspace.update({ where: { id: workspaceId }, data: input });
      await recordActivity(db, {
        workspaceId,
        userId,
        action: 'workspace.updated',
        entityType: 'workspace',
        entityId: workspaceId,
        metadata: { fields: Object.keys(input) },
      });
      return describe(workspaceId, 'owner', userId);
    },
  };
}
