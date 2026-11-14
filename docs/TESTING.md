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

| Check                                       | Result               |
| ------------------------------------------- | -------------------- |
| Unit tests                                  | 89 passed            |
| Integration tests (real MySQL)              | 156 passed           |
| End-to-end tests (Playwright)               | 15 passed            |
| TypeScript (`tsc --noEmit`, app and e2e)    | clean                |
| ESLint, Prettier                            | clean                |
| Production build, built server smoke test   | passes               |
| Docker image build and container smoke test | passes (run locally) |

CI runs all of the above on every push and pull request; the workflow is in `.github/workflows/ci.yml`. Its result for this branch is reported in the completion report, not claimed here.

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

**Concurrency**: simultaneous launches yield exactly one success; simultaneous pauses likewise; a stale draft edit is rejected.

## Bugs the tests found

Recorded because they are the point of testing:

- Concurrent claims deadlocked under the default isolation level, and then silently starved all but one worker because of the optimiser's join order.
- Scheduling dropped seconds and milliseconds when adding a delay, so step two could go out up to a minute early. (Unit tests had used whole minutes.)
- Rate-limit keys for IPv6 clients were not normalised (caught by a library warning during tests).
- The dashboard's "reachable contacts" subtracted suppression _entries_ rather than suppressed _contacts_, which is wrong when an address has no contact.
- The SPA fallback mistook an unsubscribe token containing a dot for a file.
- Frontend: `event.currentTarget` is `null` after an `await`, which broke the launch button (found by the E2E journey).
- Production only: the generated Prisma client imported `.ts` files that do not exist in the compiled output (found by running the Docker image, not by any test, which is why a smoke test now runs against the built server in CI).

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
