import type { Prisma } from '../../generated/prisma/client.js';
import type { Db, Tx } from '../../lib/db.js';

type ActivityEntry = {
  workspaceId: number;
  userId?: number | null;
  action: string;
  entityType?: string;
  entityId?: number;
  metadata?: Prisma.InputJsonValue;
};

export async function recordActivity(client: Db | Tx, entry: ActivityEntry): Promise<void> {
  await client.activityLog.create({
    data: {
      workspaceId: entry.workspaceId,
      userId: entry.userId ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
    },
  });
}
