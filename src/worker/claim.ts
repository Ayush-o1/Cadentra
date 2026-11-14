import type { Db } from '../lib/db.js';

export type ClaimOptions = {
  now: Date;
  limit: number;
  workerId: string;
  leaseMs: number;
};

export type ClaimedMessage = { id: number; attempts: number };

type IdRow = { id: number };

/**
 * Atomically takes up to `limit` due messages for this worker.
 *
 * A message is due when it is scheduled and its run time has passed, or when a previous
 * worker claimed it and never finished (its lease expired). Only messages of running
 * campaigns are returned, so pausing a campaign stops its sending immediately.
 *
 * `FOR UPDATE SKIP LOCKED` lets concurrent workers claim different rows without waiting
 * on each other, and the status change commits together with the row locks.
 *
 * The index hint and STRAIGHT_JOIN are deliberate. Without them MySQL starts from the
 * campaigns table and sorts, which makes the locking read lock every due row before applying
 * LIMIT, so concurrent workers would skip everything. With them, rows are read and locked in
 * index order and the scan stops at LIMIT.
 *
 * This relies on the connection pool running at READ COMMITTED (see createDb). Under
 * REPEATABLE READ, InnoDB also takes gap locks while scanning the (status, run_at) index,
 * and concurrent claimers then deadlock with each other.
 */
export async function claimDueMessages(db: Db, options: ClaimOptions): Promise<ClaimedMessage[]> {
  const { now, limit, workerId, leaseMs } = options;
  const lockedUntil = new Date(now.getTime() + leaseMs);

  return db.$transaction(async (tx) => {
    const scheduled = await tx.$queryRaw<IdRow[]>`
      SELECT m.id
      FROM email_messages m FORCE INDEX (idx_messages_status_run_at)
      STRAIGHT_JOIN campaigns c ON c.id = m.campaign_id AND c.status = 'running'
      WHERE m.status = 'scheduled' AND m.run_at <= ${now}
      ORDER BY m.run_at, m.id
      LIMIT ${limit}
      FOR UPDATE OF m SKIP LOCKED`;

    const remaining = limit - scheduled.length;
    const abandoned =
      remaining > 0
        ? await tx.$queryRaw<IdRow[]>`
            SELECT m.id
            FROM email_messages m FORCE INDEX (idx_messages_status_run_at)
            STRAIGHT_JOIN campaigns c ON c.id = m.campaign_id AND c.status = 'running'
            WHERE m.status = 'sending' AND m.locked_until < ${now}
            ORDER BY m.locked_until, m.id
            LIMIT ${remaining}
            FOR UPDATE OF m SKIP LOCKED`
        : [];

    const ids = [...scheduled, ...abandoned].map((row) => row.id);
    if (ids.length === 0) return [];

    await tx.emailMessage.updateMany({
      where: { id: { in: ids } },
      data: { status: 'sending', lockedBy: workerId, lockedUntil, attempts: { increment: 1 } },
    });

    return tx.emailMessage.findMany({
      where: { id: { in: ids } },
      select: { id: true, attempts: true },
      orderBy: { id: 'asc' },
    });
  });
}
