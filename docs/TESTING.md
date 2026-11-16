# Testing

## Strategy

| Level       | Tooling                               | What it covers                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | Vitest                                | Pure logic with no I/O: scheduling and time zones, retry decisions, health limits, campaign transitions, merge fields, message composition, tokens, the Resend client (against a mocked `fetch`), analytics maths, and the pure frontend modules |
| Integration | Vitest, Supertest, **real MySQL 8.4** | HTTP API end to end, authorization across workspaces, database constraints and transactions, the queue claim and worker, webhooks, unsubscribe, analytics                                                                                        |
| End to end  | Playwright (Chromium)                 | A real server with the worker running and the simulated provider, driven through the browser                                                                                                                                                     |

There is no SQLite or in-memory substitute: integration tests run against the same MySQL version as production, because constraints, locking and isolation behaviour are what they exist to check. Locally that is the Docker Compose container (`npm run db:up`); CI uses a service container. The database is migrated before the suite starts (`prisma migrate deploy`) and wiped between tests.

The email provider in automated tests is always the explicit `FakeProvider`. No test sends real email or contacts Resend.

## Results for this release

| Check                                                                     | Result                                      |
| ------------------------------------------------------------------------- | ------------------------------------------- |
| Unit tests                                                                | 115 passed                                  |
| Integration tests (real MySQL)                                            | 178 passed                                  |
| Integration tests, `conditional-update` claim mode                        | 178 passed (5 full runs, no failure)        |
| End-to-end tests (Playwright)                                             | 20 passed (full suite run 4 times in a row) |
| TypeScript (`tsc --noEmit`, app and e2e)                                  | clean                                       |
| ESLint, Prettier                                                          | clean                                       |
| Production build, built server smoke test                                 | passes                                      |
| Docker image build, container smoke test, non-root, `docker stop` exits 0 | passes (run locally, and in CI)             |
| `docker-compose.prod.yml` up, smoke test, stop, restart                   | passes (run locally)                        |
| `npm audit --omit=dev`                                                    | 0 vulnerabilities                           |

CI runs all of the above on every push and pull request; the workflow is in `.github/workflows/ci.yml`. The run for the first push to `main` (dependency-audit commit, run 43630606663) passed both jobs. The changes in this document's latest sections were verified locally from a fresh clone against a brand-new database; their CI result is reported in the hand-off message, not claimed here.

The 20 end-to-end tests, the 178 integration tests and the 110 unit tests were counted from a fresh clone (`npm ci`, new empty database) at the commit that precedes this paragraph. Concurrency-heavy files (worker, database, webhooks, account recovery) were additionally repeated 8 times in each claim mode with no failures.

## What the important tests prove

**Duplicate-send prevention** (`worker.test.ts`)

- A worker that sent through the provider and died before recording the result is replaced after its lease expires; the second worker sends with the same idempotency key and the provider receives **one** email.
- Three workers running at once over 30 messages produce exactly 30 provider calls with 30 distinct keys.
- Recording a second message for the same recipient and step is rejected by the database.

**Queue behaviour** (`database.test.ts`, `worker.test.ts`)

- Four competing claimers receive disjoint batches that add up to everything due. (This test found two real problems: the isolation level and the query plan. See DATABASE_DESIGN.)
- Paused and cancelled campaigns are never claimed. Expired leases are reclaimed and live ones are not.
- Retry: a transient failure is rescheduled with the right backoff; a permanent one fails at once and stops that recipient; five transient failures end in `failed`.
- The window and the daily limit reschedule a message without counting an attempt.

**Opt-outs** (`unsubscribe.test.ts`, `webhooks.test.ts`, `contacts.test.ts`)

- Unsubscribing through the link, the one-click POST, a bounce, a spam report and a manual block each suppress the address, cancel pending messages and stop that recipient's later steps, even for messages already scheduled.
- A contact deleted and re-created while suppressed is still suppressed.

**Webhooks** (`webhooks.test.ts`): correct signatures accepted; missing, forged, tampered and stale ones rejected with nothing stored; a redelivered event applied once; out-of-order events never move a message backwards; events that arrive before the message is recorded are applied afterwards.

**Tenant isolation**: every resource endpoint is called from a second workspace and must answer 404; the database-level tests insert cross-tenant links directly and expect foreign-key errors.

**Concurrency**: simultaneous launches yield exactly one success; simultaneous pauses likewise; a stale draft edit is rejected; two simultaneous uses of one password-reset link yield one success and one 400.

**Queue claim, both modes** (`database.test.ts`, `worker.test.ts`): the claim tests are generated for `skip-locked` and `conditional-update` and must pass in both; the three-workers test runs in both; and the entire integration suite can be switched to the alternative mode with `TEST_CLAIM_MODE=conditional-update`. A unit test covers which database errors count as "lost the race" (deadlock, lock wait timeout, TiDB write conflict) and which are real failures.

**Account recovery** (`account-recovery.test.ts`, `account-recovery.spec.ts`): identical answers for known and unknown addresses; only the hash is stored and the link carries the secret in the fragment; reset ends every session and spends the token; expired, unknown, used and wrong-purpose tokens refused; an earlier link dies when a new one is requested; a too-weak password leaves the token usable; per-address rate limit; provider failure does not leak or fail the request; verification flow; the optional launch requirement. The browser tests plant a token the way the server would (the simulated provider sends nothing a browser can read) and walk the pages, including a second signed-in device being signed out.

**Resend client against a mocked `fetch`** (`resend.provider.test.ts`): request shape, key and idempotency headers; each documented error class (bad key, unverified domain, daily and monthly quota, idempotency conflict, concurrent idempotent request, rate limit with `Retry-After`, 5xx, timeout, non-JSON error body); the API key never appears in an error. A worker test shows a quota error reschedules without using an attempt. Webhook tests cover signature, tampering, replay window, redelivery and out-of-order events, and a redelivery of an event that was stored but not applied.

**Configuration** (`env.test.ts`): required variables, blank values, `.env.example` and `.env.production.example` load as shipped, proxy hop counts, claim mode, system sender.

## Bugs the tests found

Recorded because they are the point of testing:

- Concurrent claims deadlocked under the default isolation level, and then silently starved all but one worker because of the optimiser's join order.
- Scheduling dropped seconds and milliseconds when adding a delay, so step two could go out up to a minute early. (Unit tests had used whole minutes.)
- Rate-limit keys for IPv6 clients were not normalised (caught by a library warning during tests).
- The dashboard's "reachable contacts" subtracted suppression _entries_ rather than suppressed _contacts_, which is wrong when an address has no contact.
- The SPA fallback mistook an unsubscribe token containing a dot for a file.
- Frontend: `event.currentTarget` is `null` after an `await`, which broke the launch button (found by the E2E journey).
- Production only: the generated Prisma client imported `.ts` files that do not exist in the compiled output (found by running the Docker image, not by any test, which is why a smoke test now runs against the built server in CI).

Found in the final review pass:

- **Docker did not stop gracefully.** The shell in `CMD` was PID 1 and swallowed SIGTERM, so `docker stop` waited out the grace period and killed the process (exit 137). Found by actually stopping the production Compose stack; fixed with `exec node`; CI now checks the stop exit code.
- **A fresh `.env.example` did not start.** `TICK_TOKEN=` and `RESEND_API_KEY=` were read as empty strings and failed validation. Blank values now count as unset, and tests load both shipped example files.
- **TLS with `ssl=true` was ignored by `prisma migrate`**, which would have connected without TLS to a TLS-only host. Found by reading how Prisma's engine parses the URL, then confirmed locally.
- **After a password reset, the page that did it stayed "signed in" in the browser**, bounced between the login and dashboard pages, and ended on `/login?next=%2F`. Found by the new browser test.
- **A background poll could overwrite a campaign's state** if its response arrived after the user paused it, showing the old status. Surfaced as an intermittent end-to-end failure; guarded with a revision counter.
- **A redelivered webhook event was discarded as a duplicate even if its first delivery had not been applied** (a crash between storing and applying). Now reprocessed.
- **`TRUST_PROXY=true` trusted a client-supplied `X-Forwarded-For`**, letting a client choose its own rate-limit bucket. It is now a hop count.
- **Resend quota and idempotency-conflict errors were handled like any transient failure**, failing messages after five attempts for reasons unrelated to them, or retrying a conflict that can never succeed.
- **Editing a contact failed before 12:00 UTC if its consent date was today** ("Consent cannot be dated in the future"). The edit form re-sent the consent date as noon UTC even when untouched. It surfaced when CI happened to run at 06:43 UTC, after passing on every earlier run (all of which ran in the afternoon or evening UTC). Reproduced locally at 06:46 UTC, fixed by sending the date only when it was changed and never later than now (`consentChange`, with unit tests). A reminder that time-of-day matters as much as time zones.
- **List pages could show stale results**: a slow response for an older search term could arrive after a newer one and overwrite it. Contacts, suppressions, campaigns, list detail and analytics now apply only the newest request (`latestOnly`).
- Test-data collisions when end-to-end tests ran in parallel (duplicate generated emails) were removed.

## Running the tests

```bash
npm run db:up            # MySQL for integration tests
npm test                 # unit + integration
npm run test:e2e         # Playwright (starts its own server on port 3100)
```

`TEST_DATABASE_URL` overrides the test database (default `mysql://cadentra:cadentra@127.0.0.1:3307/cadentra_test`). End-to-end tests use the same database, so run them after the integration suite rather than at the same time.

## Not covered

- Real Resend: the client is tested against a mocked `fetch`, and webhooks against payloads signed with a known secret. Neither has been exercised against Resend itself.
- Browsers other than Chromium, and real mobile devices (a phone-sized viewport is tested).
- Screen-reader use. The automated axe scan catches a class of problems, not all of them.
- Load testing. Query plans were reviewed on a 50,000-row dataset (see DATABASE_DESIGN); throughput under concurrent web traffic was not measured.
- Failure injection against MySQL (connection loss mid-transaction).
- **TiDB**: nothing has run on it. The alternative claim mode, the compatibility script and the TLS handling were verified on MySQL 8.4 only; [TIDB_COMPATIBILITY.md](TIDB_COMPATIBILITY.md) has the procedure.
- The live Resend path (`npm run resend:live`) was verified only to refuse to run without its confirmation and key; it has never contacted Resend.
