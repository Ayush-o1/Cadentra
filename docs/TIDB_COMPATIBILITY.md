# TiDB compatibility

Cadentra is designed and tested on **MySQL 8.4**. The free hosting route in [DEPLOYMENT.md](DEPLOYMENT.md) uses TiDB Cloud Starter, which is MySQL-_compatible_, not MySQL. This document records an audit of the schema and SQL against TiDB's own documentation, what was changed because of it, and the exact procedure to verify it on a real cluster.

**Nothing here has been run against TiDB.** No TiDB account was available. Every statement below about TiDB comes from its published documentation (the `master` branch of `pingcap/docs`, read on 2026-11-15) and is marked as such. What _has_ been run is the MySQL 8.4 side: the new code paths are tested there, and a verification script was written that will tell you in a minute whether TiDB behaves as the documentation says.

## Result of the audit

| Area                                                            | What Cadentra uses                                                                | What TiDB's documentation says                                                                                                                                                                                                                                  | Verdict                                                                                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **`FOR UPDATE SKIP LOCKED`** (the default queue claim)          | One locking read, the heart of the queue                                          | Listed under _unsupported features_ in the MySQL compatibility page (`SKIP LOCKED` syntax, issue #18207). `FOR UPDATE … NOWAIT` is supported, `SKIP LOCKED` is not                                                                                              | **Would break.** Fixed: a second claim mode (below)                                                                         |
| `FORCE INDEX`, `STRAIGHT_JOIN`, `FOR UPDATE OF t`               | In the default claim                                                              | Index hints and `FOR UPDATE OF` are supported syntax                                                                                                                                                                                                            | Not needed by the new mode's writes; fine                                                                                   |
| **Composite foreign keys** with `ON DELETE/UPDATE CASCADE`      | Every tenant-owned link includes `workspace_id`                                   | Foreign keys are enforced from v6.6 and generally available from v8.5.0. Requirements: same type, size, charset and collation on both sides; an index on the referenced columns in matching order; no TEXT/BLOB key columns; no partitioned tables. We meet all | Expected to work **if the cluster is v8.5 or newer**. Verify                                                                |
| **`CHECK` constraints** (14, written by hand in the migration)  | Defence in depth: lower-cased emails, window ranges, lease consistency, and so on | **Disabled by default.** `tidb_enable_check_constraint` is `OFF`, scope `GLOBAL` only. With it off, the constraint is not enforced                                                                                                                              | **Probably silently not enforced on Starter**, where you cannot set globals. The application enforces the same rules itself |
| `READ COMMITTED` set on every connection                        | `SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED`                          | Supported since v4.0, but **takes effect only in pessimistic transaction mode** (otherwise stays Repeatable Read). Pessimistic is the default; `tidb_txn_mode` is read-only on Starter                                                                          | Expected to work. Verify with the script                                                                                    |
| Gap locks                                                       | Not used by the new mode. (The default mode needed READ COMMITTED to avoid them)  | TiDB has no gap locks                                                                                                                                                                                                                                           | Not a problem                                                                                                               |
| Autocommit `UPDATE` racing another `UPDATE`                     | The new claim: one conditional `UPDATE` per message                               | In pessimistic mode an autocommit statement first tries an optimistic commit; on a write conflict it is **retried in pessimistic mode**, which re-reads the row                                                                                                 | The condition is re-checked, so exactly one worker wins. Conflict errors are also caught and treated as "lost the race"     |
| `GET_LOCK` / `RELEASE_LOCK`                                     | Taken by `prisma migrate` around migrations                                       | Supported (cluster-wide). `IS_FREE_LOCK`/`IS_USED_LOCK` are not, but Prisma does not need them as far as was found                                                                                                                                              | Expected to work. Verify with `db:compat` and `migrate deploy`                                                              |
| DDL in migrations                                               | `CREATE TABLE`, `ALTER TABLE … ADD CONSTRAINT`                                    | Online DDL, **not transactional**: a failed migration can leave it half applied                                                                                                                                                                                 | Run `migrate deploy` on an empty database first                                                                             |
| Collation `utf8mb4_unicode_ci`, `DATETIME(3)`, `AUTO_INCREMENT` | Every table; emails compare case-insensitively                                    | Supported. TiDB's own default collation differs (`utf8mb4_bin`) but ours is stated per table. Auto-increment ids are unique, **not sequential**, across TiDB servers                                                                                            | Fine. Nothing relies on ids being gap-free                                                                                  |
| Transaction length                                              | All transactions are short                                                        | Starter: a transaction may not run longer than 30 minutes                                                                                                                                                                                                       | Fine                                                                                                                        |
| Connection lifetime                                             | Pool of 10                                                                        | Starter drops idle public-endpoint connections (340 s) and may close any connection after 30 minutes. 400 concurrent connections                                                                                                                                | Pool now recycles idle connections after 240 s (`idleTimeout`)                                                              |
| **TLS**                                                         | `?ssl=true`                                                                       | Starter requires TLS on the public endpoint                                                                                                                                                                                                                     | Works for the app **and** for `prisma migrate` (see below)                                                                  |
| Request Units (the free allowance)                              | A poll every few seconds does a few small queries                                 | 50 million RUs a month on the free tier; once used, **new connections are refused** until the month resets                                                                                                                                                      | Poll interval is 10 s in `render.yaml`. Watch usage in the TiDB console                                                     |

## What changed in the code because of this audit

1. **`QUEUE_CLAIM_MODE=conditional-update`** (`src/worker/claim.ts`). The default stays `skip-locked`; MySQL deployments are unaffected. The alternative reads candidate ids without locks, shuffles them inside a small window to reduce collisions, then claims each with one conditional `UPDATE … WHERE id = ? AND <still due> AND <campaign still running>`. The affected-row count decides ownership: of two workers racing for one id, exactly one gets 1. No multi-statement transaction, no lock held between statements, no dependence on isolation level. The duplicate-send guards (lease, `UNIQUE (recipient_id, step_id)`, provider idempotency key) are the same in both modes.
   - Tested on **MySQL 8.4**: the five claim tests run under both modes, a concurrency test runs three workers over 30 messages under both modes, and the **entire integration suite can be run in this mode** (`TEST_CLAIM_MODE=conditional-update npm run test:integration`; it passed 3 times in a row).
   - Not tested on TiDB.
2. **`?ssl=true` now works for migrations too.** Prisma's migration engine ignores `ssl=true` and would connect without TLS, which a TLS-only host rejects. `prisma.config.ts` translates it to `sslaccept=strict`. Verified locally against MySQL's self-signed TLS: with `ssl=true` both the app and `migrate` refuse the untrusted certificate (so verification really is on), and with `?sslaccept=accept_invalid_certs` both connect and the compatibility script reports `TLS in use`.
3. **Pool recycles idle connections** (`idleTimeout: 240`, `minimumIdle: 2`).
4. **`scripts/db-compat-check.ts`** (`npm run db:compat`), described below.
5. `render.yaml` sets `QUEUE_CLAIM_MODE=conditional-update` and `WORKER_POLL_MS=10000`.

## What is not fixed, and why

- **CHECK constraints may not be enforced on TiDB Starter.** I did not remove them: on MySQL they are real protection, and the migration is the same for every database. The application validates the same rules (Zod schemas, the sending-window and lease logic), so behaviour is unchanged; the database-level safety net is missing. If `migrate deploy` _fails_ on a `chk_*` statement instead of ignoring it, stop and report the exact error. The documentation says the feature is "disabled", not that the statement errors, but that was not tested. Four tests in `tests/integration/database.test.ts` (`check constraints`) are expected to fail on such a host; they prove the constraint, not the application.
- **The default `skip-locked` mode cannot run on TiDB.** Six tests are expected to fail there (listed below). That is the reason the other mode exists.
- Whether the cluster you get is v8.5 or newer. Foreign keys before v6.6 were parsed but not enforced. The script prints the version and checks enforcement directly.

## Verification procedure (about 20 minutes, needs your TiDB account)

Use a **dedicated, empty database** for this. The integration suite deletes all rows from its database. Never point it at data you care about.

1. In TiDB Cloud, create a Starter cluster. Leave the monthly spending limit at **0**. Create a database named `cadentra_verify` (SQL editor: `CREATE DATABASE cadentra_verify;`). Under **Connect**, choose the public endpoint, note the host, port (4000), user and password. Do not paste them into chat or a file in the repository.
2. In a terminal in the repository, set the URL for this shell session only (the leading space keeps it out of shell history in most shells):

   ```bash
    export VERIFY_URL='mysql://USER:PASSWORD@HOST:4000/cadentra_verify?ssl=true'
   ```

   URL-encode special characters in the password (`@` becomes `%40`).

3. **Feature check** (creates and drops its own `cadentra_compat_*` tables):

   ```bash
   DATABASE_URL="$VERIFY_URL" npm run db:compat
   ```

   Expected on TiDB: `Server` shows a TiDB version (`8.5.x` or later is what you want), `Connection encryption` shows TLS, every `PASS`, the SKIP LOCKED line shows `INFO … Not supported … conditional-update`, and the CHECK line shows **`WARN`** (not enforced) unless TiDB enforces it. Any `FAIL` on foreign keys, READ COMMITTED, the concurrent claim or advisory locks means this host does not support the design: stop there.

4. **Migrations** on the empty database:

   ```bash
   DATABASE_URL="$VERIFY_URL" npx prisma migrate deploy
   ```

   Expected: both migrations apply. A failure naming a `chk_*` or `FOREIGN KEY` statement is the finding to report.

5. **The real test suite in the alternative claim mode**:

   ```bash
   TEST_DATABASE_URL="$VERIFY_URL" TEST_CLAIM_MODE=conditional-update npm run test:integration
   ```

   Expected on TiDB: everything passes **except** these known, explained cases:
   - `claimDueMessages (skip-locked)`: 5 tests, and `never hands one message to two workers running at the same time (skip-locked)`: 1 test. `SKIP LOCKED` is unsupported.
   - `check constraints`: 4 tests, if step 3 showed `WARN`.

   Anything else failing is a real incompatibility. Keep the output.

6. If steps 3 to 5 are as expected, use the TiDB database for the deployment with `QUEUE_CLAIM_MODE=conditional-update` (already set in `render.yaml`). Create a **separate** database (`cadentra`) for the live app so the verification database can be dropped.

## If it does not work

The fallback in [DEPLOYMENT.md](DEPLOYMENT.md) is a real MySQL: any managed MySQL 8, or a container, with the default `skip-locked` mode. Nothing in the application is TiDB-specific, so that switch is a connection-string change.

## Sources

- TiDB MySQL compatibility, unsupported features (`SKIP LOCKED`): <https://docs.pingcap.com/tidb/stable/mysql-compatibility/>
- Foreign keys: <https://docs.pingcap.com/tidb/stable/foreign-key/>
- Constraints (`CHECK` disabled by default): <https://docs.pingcap.com/tidb/stable/constraints/>
- Transaction isolation, Read Committed: <https://docs.pingcap.com/tidb/stable/transaction-isolation-levels/>
- Pessimistic transactions (autocommit behaviour, no gap locks): <https://docs.pingcap.com/tidb/stable/pessimistic-transaction/>
- Locking functions: <https://docs.pingcap.com/tidb/stable/locking-functions/>
- Starter limits and request units: <https://docs.pingcap.com/tidbcloud/serverless-limitations/>
