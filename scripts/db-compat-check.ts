/**
 * Database compatibility check for MySQL-compatible hosts (built for TiDB Cloud, works on MySQL).
 *
 *   npm run db:compat                      # uses DATABASE_URL from .env
 *   DATABASE_URL='mysql://…?ssl=true' npm run db:compat
 *
 * It creates a few throwaway tables whose names start with `cadentra_compat_`, exercises the
 * database features Cadentra relies on through the same driver the app uses, prints a verdict
 * for each, and drops the tables again. It never reads or touches any other table, so it is safe
 * to point at an empty or existing database. Exit code 1 means a REQUIRED feature failed.
 *
 * The authoritative check is still the real test suite against the host:
 *   TEST_DATABASE_URL='…' TEST_CLAIM_MODE=conditional-update npm run test:integration
 */
import { createDb } from '../src/lib/db.js';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('Set DATABASE_URL (for example in .env) and run again.');
  process.exit(2);
}

const db = createDb(url);
const P = 'cadentra_compat_';
type Verdict = 'PASS' | 'FAIL' | 'WARN' | 'INFO';
const results: { name: string; verdict: Verdict; detail: string }[] = [];

function record(name: string, verdict: Verdict, detail = ''): void {
  results.push({ name, verdict, detail });
  console.log(`  ${verdict.padEnd(4)}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error('Expected a row but the query returned none');
  return row;
}

async function exec(sql: string): Promise<void> {
  await db.$executeRawUnsafe(sql);
}

async function rejects(sql: string): Promise<string | null> {
  try {
    await exec(sql);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.split('\n').pop()!.slice(0, 160) : String(error);
  }
}

async function dropAll(): Promise<void> {
  await exec('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of ['messages', 'campaigns', 'workspaces', 'queue', 'locks']) {
    await exec(`DROP TABLE IF EXISTS ${P}${table}`);
  }
  await exec('SET FOREIGN_KEY_CHECKS = 1');
}

async function main(): Promise<void> {
  console.log('Cadentra database compatibility check\n');

  const { v } = one(await db.$queryRawUnsafe<{ v: string }[]>('SELECT VERSION() AS v'));
  const isTidb = /tidb/i.test(v ?? '');
  record('Server', 'INFO', `${v}${isTidb ? '  (TiDB detected)' : ''}`);

  try {
    const cipher = await db.$queryRawUnsafe<{ Value: string }[]>(
      "SHOW SESSION STATUS LIKE 'Ssl_cipher'",
    );
    const value = cipher[0]?.Value;
    record('Connection encryption', 'INFO', value ? `TLS in use (${value})` : 'NOT encrypted');
  } catch {
    record('Connection encryption', 'INFO', 'could not be determined on this server');
  }

  const { level } = one(
    await db.$queryRawUnsafe<{ level: string }[]>('SELECT @@transaction_isolation AS level'),
  );
  record(
    'Pool runs at READ COMMITTED',
    level === 'READ-COMMITTED' ? 'PASS' : 'FAIL',
    `@@transaction_isolation = ${level}`,
  );

  await dropAll();
  try {
    // Schema shaped like the real one: composite tenant keys, a CHECK, the queue index.
    await exec(
      `CREATE TABLE ${P}workspaces (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50) NOT NULL) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await exec(
      `CREATE TABLE ${P}campaigns (
         id INT AUTO_INCREMENT PRIMARY KEY, workspace_id INT NOT NULL,
         status VARCHAR(20) NOT NULL DEFAULT 'running',
         UNIQUE KEY uq_ws_id (workspace_id, id),
         CONSTRAINT fk_c_ws FOREIGN KEY (workspace_id) REFERENCES ${P}workspaces (id) ON DELETE CASCADE ON UPDATE CASCADE
       ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await exec(
      `CREATE TABLE ${P}messages (
         id INT AUTO_INCREMENT PRIMARY KEY, workspace_id INT NOT NULL, campaign_id INT NOT NULL,
         status VARCHAR(20) NOT NULL DEFAULT 'scheduled', run_at DATETIME(3) NOT NULL,
         locked_by VARCHAR(64) NULL, locked_until DATETIME(3) NULL, attempts TINYINT NOT NULL DEFAULT 0,
         to_email VARCHAR(254) NOT NULL,
         UNIQUE KEY uq_msg_email (campaign_id, to_email),
         KEY idx_msg_status_run_at (status, run_at),
         CONSTRAINT fk_m_campaign FOREIGN KEY (workspace_id, campaign_id) REFERENCES ${P}campaigns (workspace_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
         CONSTRAINT chk_m_lease CHECK (status <> 'sending' OR (locked_by IS NOT NULL AND locked_until IS NOT NULL))
       ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    record('Tables with composite foreign keys, CHECK and queue index create', 'PASS');
  } catch (error) {
    record('Create tables', 'FAIL', String(error).slice(0, 300));
    await dropAll();
    return;
  }

  await exec(`INSERT INTO ${P}workspaces (name) VALUES ('a'), ('b')`);
  const ws = await db.$queryRawUnsafe<{ id: number }[]>(
    `SELECT id FROM ${P}workspaces ORDER BY id`,
  );
  const [wsA, wsB] = [ws[0]!.id, ws[1]!.id];
  await exec(`INSERT INTO ${P}campaigns (workspace_id) VALUES (${wsA})`);
  const { id: campaignId } = one(
    await db.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM ${P}campaigns`),
  );

  // Composite foreign key actually enforced (tenant isolation at the database level).
  const crossTenant = await rejects(
    `INSERT INTO ${P}messages (workspace_id, campaign_id, run_at, to_email) VALUES (${wsB}, ${campaignId}, NOW(3), 'x@example.org')`,
  );
  record(
    'Composite foreign key rejects a cross-tenant row',
    crossTenant ? 'PASS' : 'FAIL',
    crossTenant ?? 'The insert succeeded: foreign keys are NOT enforced. Required.',
  );

  // CHECK constraint enforcement (defence in depth; the application validates the same rules).
  const badLease = await rejects(
    `INSERT INTO ${P}messages (workspace_id, campaign_id, status, run_at, to_email) VALUES (${wsA}, ${campaignId}, 'sending', NOW(3), 'y@example.org')`,
  );
  record(
    'CHECK constraint is enforced',
    badLease ? 'PASS' : 'WARN',
    badLease ??
      'Accepted but NOT enforced (TiDB: tidb_enable_check_constraint is OFF and GLOBAL-only). ' +
        'The app validates these rules itself; the database safety net is missing. Document it.',
  );
  if (!badLease) await exec(`DELETE FROM ${P}messages WHERE to_email = 'y@example.org'`);

  // Cascading delete through the composite key.
  await exec(
    `INSERT INTO ${P}messages (workspace_id, campaign_id, run_at, to_email) VALUES (${wsA}, ${campaignId}, NOW(3), 'z@example.org')`,
  );
  await exec(`DELETE FROM ${P}campaigns WHERE id = ${campaignId}`);
  const { n } = one(
    await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM ${P}messages`),
  );
  record('ON DELETE CASCADE follows the composite key', Number(n) === 0 ? 'PASS' : 'FAIL');

  // Unique constraint.
  await exec(`INSERT INTO ${P}campaigns (workspace_id) VALUES (${wsA})`);
  const { id: c2 } = one(
    await db.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM ${P}campaigns LIMIT 1`),
  );
  await exec(
    `INSERT INTO ${P}messages (workspace_id, campaign_id, run_at, to_email) VALUES (${wsA}, ${c2}, NOW(3), 'dup@example.org')`,
  );
  const dup = await rejects(
    `INSERT INTO ${P}messages (workspace_id, campaign_id, run_at, to_email) VALUES (${wsA}, ${c2}, NOW(3), 'dup@example.org')`,
  );
  record(
    'UNIQUE constraint rejects duplicates',
    dup ? 'PASS' : 'FAIL',
    dup ?? 'duplicate accepted',
  );
  await exec(`DELETE FROM ${P}messages`);

  // The default claim query and its index hints.
  let skipLockedWorks = false;
  try {
    await db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT m.id FROM ${P}messages m FORCE INDEX (idx_msg_status_run_at)
         STRAIGHT_JOIN ${P}campaigns c ON c.id = m.campaign_id AND c.status = 'running'
         WHERE m.status = 'scheduled' AND m.run_at <= NOW(3)
         ORDER BY m.run_at, m.id LIMIT 5 FOR UPDATE OF m SKIP LOCKED`,
      );
    });
    skipLockedWorks = true;
  } catch (error) {
    record(
      'FOR UPDATE SKIP LOCKED (default claim mode)',
      'INFO',
      `Not supported: ${String(error).split('\n').pop()!.slice(0, 160)}\n        ` +
        '-> set QUEUE_CLAIM_MODE=conditional-update',
    );
  }
  if (skipLockedWorks) {
    record(
      'FOR UPDATE SKIP LOCKED with FORCE INDEX and STRAIGHT_JOIN',
      'PASS',
      '-> QUEUE_CLAIM_MODE=skip-locked works (the default)',
    );
  }

  // Concurrent claims with the conditional-update strategy: no row may be claimed twice.
  await exec(`CREATE TABLE ${P}queue (
      id INT AUTO_INCREMENT PRIMARY KEY, status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
      run_at DATETIME(3) NOT NULL, locked_by VARCHAR(64) NULL, locked_until DATETIME(3) NULL,
      attempts TINYINT NOT NULL DEFAULT 0, KEY idx_q (status, run_at))`);
  const rows = 120;
  await exec(
    `INSERT INTO ${P}queue (run_at) VALUES ${Array.from({ length: rows }, () => '(NOW(3))').join(',')}`,
  );
  const now = new Date(Date.now() + 1000);
  const workers = ['w1', 'w2', 'w3', 'w4'];
  const claimed = await Promise.all(
    workers.map(async (worker) => {
      const mine: number[] = [];
      for (;;) {
        const candidates = await db.$queryRawUnsafe<{ id: number }[]>(
          `SELECT id FROM ${P}queue WHERE status = 'scheduled' AND run_at <= ? ORDER BY run_at, id LIMIT 12`,
          now,
        );
        if (candidates.length === 0) break;
        for (const { id } of candidates) {
          const affected = await db.$executeRawUnsafe(
            `UPDATE ${P}queue SET status = 'sending', locked_by = ?, locked_until = ?, attempts = attempts + 1
             WHERE id = ? AND status = 'scheduled' AND run_at <= ?`,
            worker,
            now,
            id,
            now,
          );
          if (affected === 1) mine.push(id);
        }
      }
      return mine;
    }),
  );
  const all = claimed.flat();
  const unique = new Set(all).size;
  const attemptsOk = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM ${P}queue WHERE attempts <> 1 OR status <> 'sending'`,
  );
  record(
    'Conditional-update claim: 4 concurrent workers, no duplicates, nothing lost',
    all.length === rows && unique === rows && Number(attemptsOk[0]!.n) === 0 ? 'PASS' : 'FAIL',
    `claimed ${all.length} of ${rows}, ${unique} distinct, per worker ${claimed.map((c) => c.length).join('/')}`,
  );

  // Advisory locks (Prisma Migrate takes one around every migrate command).
  try {
    const { got } = one(
      await db.$queryRawUnsafe<{ got: bigint | number | null }[]>(
        `SELECT GET_LOCK('${P}probe', 5) AS got`,
      ),
    );
    await db.$queryRawUnsafe(`SELECT RELEASE_LOCK('${P}probe')`);
    record('GET_LOCK / RELEASE_LOCK (used by prisma migrate)', Number(got) === 1 ? 'PASS' : 'FAIL');
  } catch (error) {
    record('GET_LOCK / RELEASE_LOCK (used by prisma migrate)', 'FAIL', String(error).slice(0, 200));
  }

  // Millisecond precision round trip.
  const stamp = new Date('2026-03-01T10:20:30.123Z');
  const { t } = one(
    await db.$queryRawUnsafe<{ t: Date }[]>('SELECT CAST(? AS DATETIME(3)) AS t', stamp),
  );
  record(
    'DATETIME(3) keeps milliseconds',
    new Date(t).getTime() === stamp.getTime() ? 'PASS' : 'FAIL',
    `sent ${stamp.toISOString()}, got ${new Date(t).toISOString()}`,
  );

  await dropAll();
}

try {
  await main();
} catch (error) {
  record('Unexpected error', 'FAIL', String(error).slice(0, 400));
  await dropAll().catch(() => undefined);
} finally {
  await db.$disconnect();
}

const failed = results.filter((r) => r.verdict === 'FAIL').length;
const warned = results.filter((r) => r.verdict === 'WARN').length;
console.log(
  `\n${failed === 0 ? 'No required feature failed.' : `${failed} required check(s) FAILED.`}${warned ? ` ${warned} warning(s).` : ''}`,
);
console.log('Throwaway tables were dropped. This script does not replace the integration suite.');
process.exit(failed === 0 ? 0 : 1);
