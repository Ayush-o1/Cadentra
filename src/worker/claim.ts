import type { Db } from '../lib/db.js';

/**
 * `skip-locked` (default) is the MySQL 8 design. `conditional-update` exists for MySQL-compatible
 * databases without `SKIP LOCKED` (TiDB lists it as unsupported); see claimByConditionalUpdate.
 */
export type ClaimMode = 'skip-locked' | 'conditional-update';

export type ClaimOptions = {
  now: Date;
  limit: number;
  workerId: string;
  leaseMs: number;
  mode?: ClaimMode;
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
  if (options.mode === 'conditional-update') return claimByConditionalUpdate(db, options);
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

const CANDIDATE_WINDOW = 4;

/**
 * Claim without row-locking reads, for databases that lack `SKIP LOCKED`.
 *
 * 1. A plain read (no locks) lists candidate ids that look due.
 * 2. Each candidate is claimed with ONE conditional UPDATE whose WHERE clause repeats the
 *    "is due" test and checks the campaign is still running. The database applies the update to
 *    a row at most once per state, so of two workers racing for the same id exactly one sees an
 *    affected-row count of 1; the other sees 0 and moves on. The affected-row count, not the
 *    earlier read, decides who owns the message.
 *
 * There are no multi-statement transactions and no locks held between statements, so this is
 * also independent of isolation level and gap locking. The cost is wasted round trips when
 * workers collide, which is why candidates are shuffled inside a small window. The same
 * duplicate-send guards (lease, unique recipient/step, provider idempotency key) apply as in the
 * default mode.
 */
async function claimByConditionalUpdate(db: Db, options: ClaimOptions): Promise<ClaimedMessage[]> {
  const { now, limit, workerId, leaseMs } = options;
  const lockedUntil = new Date(now.getTime() + leaseMs);
  const window = limit * CANDIDATE_WINDOW;

  const scheduled = await db.$queryRaw<IdRow[]>`
    SELECT m.id
    FROM email_messages m FORCE INDEX (idx_messages_status_run_at)
    STRAIGHT_JOIN campaigns c ON c.id = m.campaign_id AND c.status = 'running'
    WHERE m.status = 'scheduled' AND m.run_at <= ${now}
    ORDER BY m.run_at, m.id
    LIMIT ${window}`;
  const abandoned = await db.$queryRaw<IdRow[]>`
    SELECT m.id
    FROM email_messages m FORCE INDEX (idx_messages_status_run_at)
    STRAIGHT_JOIN campaigns c ON c.id = m.campaign_id AND c.status = 'running'
    WHERE m.status = 'sending' AND m.locked_until < ${now}
    ORDER BY m.locked_until, m.id
    LIMIT ${window}`;

  const candidates = shuffle([...scheduled, ...abandoned].map((row) => row.id));
  const claimed: number[] = [];
  for (const id of candidates) {
    if (claimed.length >= limit) break;
    const affected = await db.$executeRaw`
      UPDATE email_messages
      SET status = 'sending', locked_by = ${workerId}, locked_until = ${lockedUntil},
          attempts = attempts + 1, updated_at = ${now}
      WHERE id = ${id}
        AND ((status = 'scheduled' AND run_at <= ${now})
          OR (status = 'sending' AND locked_until < ${now}))
        AND campaign_id IN (SELECT id FROM campaigns WHERE status = 'running')`;
    if (affected === 1) claimed.push(id);
  }
  if (claimed.length === 0) return [];

  return db.emailMessage.findMany({
    where: { id: { in: claimed }, lockedBy: workerId, status: 'sending' },
    select: { id: true, attempts: true },
    orderBy: { id: 'asc' },
  });
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
