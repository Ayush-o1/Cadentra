# Cadentra: Decision Log

Each entry records the alternatives and the trade-off. Entries D-01 to D-16 were proposed in Phase 0 and accepted; the **Outcome** lines say what implementation showed. D-17 onwards were made during implementation.

| ID   | Decision                                                    | Status   |
| ---- | ----------------------------------------------------------- | -------- |
| D-01 | Permission-based outreach, not cold email                   | Accepted |
| D-02 | Node 24 and TypeScript 6.0.x                                | Accepted |
| D-03 | Express 5, Zod 4                                            | Accepted |
| D-04 | Prisma 7.10 (pinned), raw SQL where needed                  | Accepted |
| D-05 | MySQL-backed queue instead of BullMQ and Redis              | Accepted |
| D-06 | Resend, behind one small interface                          | Accepted |
| D-07 | Server-side sessions in MySQL, Argon2id                     | Accepted |
| D-08 | Workspace tenancy from day one, with composite foreign keys | Accepted |
| D-09 | Vanilla JS modules, no bundler, served by Express           | Accepted |
| D-10 | Cursor pagination                                           | Accepted |
| D-11 | Vitest, Supertest, Playwright, MySQL service container      | Accepted |
| D-12 | CSV import as `text/csv` body, not multipart                | Accepted |
| D-13 | Provider API key from environment, not per workspace        | Accepted |
| D-14 | Hosting decided in Phase 10 after a spike                   | Accepted |
| D-15 | Steps belong to a campaign; no reusable sequence entity     | Accepted |
| D-16 | No open tracking                                            | Accepted |

## D-01: Permission-based outreach, not cold email

**Context.** The brief names Instantly and Smartlead, which are cold-email tools. Resend's acceptable use policy prohibits cold outreach and purchased lists (Verified, RESEARCH 4.4).
**Decision.** Every contact carries a consent basis. Launch is gated. Features whose purpose is evading filtering (warm-up, rotation) are excluded.
**Alternatives.** A provider with a cold-outreach-friendly policy (not researched), or SMTP with your own mailbox (deliverability and account-ban risk).
**Trade-off.** A narrower market story, but a defensible and honest one that matches the brief's own compliance section.
**Revisit if.** You want to target a different provider, which would change D-06 only.

## D-02: Node 24 and TypeScript 6.0.x

**Context.** Node 24 is installed and supported to 2028-04-30. Node 26 is newer on the schedule. `typescript-eslint` 8.72.2 supports TypeScript below 6.1.0, while TypeScript's `latest` is 7.0.2 (Verified).
**Decision.** Node 24 (`engines: >=24`, `.nvmrc`), TypeScript pinned to 6.0.x.
**Alternatives.** Node 26 (hosts may lag, unverified), TypeScript 7 (lint toolchain unsupported).
**Revisit if.** `typescript-eslint` adds TypeScript 7 support.

## D-03: Express 5, Zod 4

**Decision.** Express 5.3.0 and Zod 4.x. Express 5 forwards rejected promises from async handlers to the error middleware, so route code stays free of try/catch boilerplate (Not verified here; confirmed in Phase 1 with a test).
**Alternatives.** Fastify (fine, but you know Express and the job description says "Node.js", not a framework), Express 4 (older line).

## D-04: Prisma 7.10 pinned, raw SQL where needed

**Context.** Prisma's `latest` tag is a release candidate of version 8. Version 7 is documented as fully supported, with MySQL through `@prisma/adapter-mariadb` (Verified).
**Decision.** Prisma 7.10.x pinned exactly. Hand-edit migration SQL for CHECK constraints and composite keys if Prisma cannot express them. Use `$queryRaw` for the queue claim and aggregate analytics. Keep repositories as the only place that touches the client.
**Alternatives.** Kysely with plain SQL migrations (closer to SQL, more visible in code review, steeper start, and you would hand-write types), Drizzle (not researched), `mysql2` only (no types).
**Trade-off.** Prisma is familiar and its generated types teach TypeScript, but it hides SQL and is changing fast. The raw-SQL escape hatches keep the interesting MySQL work visible.
**Revisit if.** The Phase 2 spikes show Prisma fighting the schema. Switching then is cheap because no application code exists yet.

**Outcome.** The composite tenant foreign keys model cleanly in Prisma 7. CHECK constraints were added to the migration by hand. The queue claim, the contact search with its suppression join, and the analytics aggregates are raw SQL (`$queryRaw`) because they need locking reads or hand-tuned plans. Two surprises: the MariaDB adapter ignores `isolationLevel` (see D-17), and the generated client needs `importFileExtension = "js"` to run from compiled output (see D-20).

## D-05: MySQL-backed queue instead of BullMQ and Redis

**Context.** See RESEARCH 4.3.
**Decision.** `email_messages` is the queue, claimed with `FOR UPDATE SKIP LOCKED` and a lease. Retries, backoff and idempotency are implemented by us.
**Alternatives.** BullMQ plus Redis (mature retries, delayed jobs and dashboards, but needs persistent Redis with `noeviction`, dual writes, extra hosting), Redis not needed at all.
**Trade-off.** More hand-written logic and polling latency (seconds), in exchange for transactional consistency, one fewer service, and a design that exercises transactions and locking. Message processing is a plain function, so a later move to BullMQ is contained.
**Revisit if.** Sustained volume exceeds what polling a single table handles, which is far beyond this project.

**Outcome.** Worked as designed, and the transactional benefit was real: the next step's message is created in the same transaction that records the send. It needed two non-obvious fixes to be correct under concurrency (D-17, D-18). `SKIP LOCKED` is confirmed on MySQL 8.4; it is unconfirmed on TiDB.

## D-06: Resend behind one small interface

**Decision.** `EmailProvider.send(message, idempotencyKey)`, with `ResendProvider` and `FakeProvider`. Webhooks verified through the Svix scheme.
**Alternatives.** Nodemailer with SMTP (provider-agnostic, but no delivery webhooks), Brevo or SES (not researched).
**Trade-off.** Resend has idempotency keys, delivery webhooks and test addresses, which the brief's delivery-state requirement needs. Its free plan is 100 emails per day, which is enough for a demo and not for real use.
**Open.** Sending to arbitrary real addresses needs a verified domain. A domain costs money. Test addresses work without one (to be confirmed in Phase 7).

**Outcome.** The provider is a single interface. The Resend client uses `fetch` rather than the SDK, which kept error classification explicit and let the whole client be tested against a mocked `fetch`. Webhook signatures use the `svix` package, whose `verify` returns nothing on success; the route therefore parses the verified raw body itself. Real Resend remains unexercised.

## D-07: Server-side sessions and Argon2id

**Decision.** Random opaque token in a cookie, SHA-256 hash stored in MySQL, revocable. Argon2id through `argon2`, with scrypt from `node:crypto` as the fallback if the native module will not install on the host.
**Alternatives.** JWT (stateless, but hard to revoke and easy to misuse for browser sessions), `express-session` with a MySQL store (adds a dependency whose maintenance I have not checked).
**Trade-off.** One database lookup per request in exchange for revocation and simpler reasoning.

## D-08: Workspace tenancy from day one

**Decision.** `workspaces` and `workspace_members` exist from Phase 2. Registration creates one workspace. Invitations are post-MVP. Composite foreign keys enforce isolation in the database.
**Alternatives.** Per-user ownership (`user_id` on every table), which is simpler now but makes teams a painful migration later, and a "small team" product needs teams.
**Trade-off.** Slightly more schema and slightly longer keys, for isolation that the database enforces and that you can explain precisely.

## D-09: Vanilla JS modules, no bundler

**Decision.** ES modules served as static files by Express. A small router, a fetch wrapper, UI functions, per-page modules. `// @ts-check` with JSDoc on shared modules.
**Alternatives.** React or Next.js (excluded by your brief and by the research), a TypeScript frontend compiled with esbuild (adds a build step; reasonable later).
**Trade-off.** More hand-written DOM code than a framework, but no build tooling, no dependency churn, and you can explain every line.

## D-10: Cursor pagination

**Decision.** Keyset (cursor) pagination on lists that can grow.
**Alternatives.** Offset pagination (simple, allows page numbers, slows with depth, drifts under inserts).
**Trade-off.** No jump-to-page. The UI uses Next and Previous, which suits a table of contacts.

## D-11: Test stack

**Decision.** Vitest, Supertest, Playwright. Real MySQL through Docker Compose locally and a GitHub Actions service container in CI. No Testcontainers.
**Alternatives.** Testcontainers (nice isolation, extra dependency, needs Node 22.22 or later), SQLite for tests (hides MySQL-specific behaviour, which defeats the purpose).

## D-12: CSV import as a `text/csv` body

**Decision.** The browser reads the file and POSTs it as `text/csv`, with a size cap. Parsed with `csv-parse`.
**Alternatives.** `multer` or `busboy` multipart upload (extra dependency for a file that fits in memory).
**Trade-off.** Not suitable for very large files, which the row cap already excludes.

## D-13: Provider key from environment

**Decision.** One Resend key in the deployment environment. Settings shows provider status read-only.
**Alternatives.** Per-workspace keys encrypted with AES-256-GCM (post-MVP, needs key management).
**Note.** The brief lists "provider configuration" in Settings. This satisfies it as status plus sender identity, and defers bring-your-own-key honestly.

## D-14: Hosting decided in Phase 10

**Decision.** Develop against Docker MySQL 8.4. Decide hosting after a compatibility spike. Leading options: always-on small compute plus a real MySQL for roughly $5 to $15 per month, or free tiers plus an external scheduled call to a protected tick endpoint (with cold starts).
**Why defer.** Prices and free tiers changed repeatedly in the sources I read, and the worker needs always-on compute or the tick design.
**Revisit before Phase 2** if you have a firm budget.

**Outcome.** Not deployed: no accounts, credentials or approved spend. The image, compose file, Render blueprint, tick workflow and smoke test are written; the image is verified locally. See DEPLOYMENT.md.

## D-15: Steps belong to a campaign

**Decision.** `campaign_steps` belongs to one campaign. No reusable sequence entity.
**Alternatives.** `email_sequences` as a first-class, reusable object.
**Trade-off.** Fewer tables and a simpler UI. Reuse is a template feature, which is post-MVP.

## D-16: No open tracking

**Decision.** Opens are not measured, and no tracking pixel is added.
**Why.** The brief says to avoid analytics the system cannot reliably measure. Mail clients that prefetch images inflate opens. Skipping the pixel also removes a privacy concern. Resend does emit `email.opened`, and the schema will tolerate storing it later.

## D-17: Connection pool at READ COMMITTED

**Context.** Four concurrent claim transactions deadlocked at MySQL's default REPEATABLE READ (InnoDB gap locks on the status index). Prisma's per-transaction `isolationLevel` was ignored by the MariaDB adapter (a test showed the level stayed REPEATABLE READ).
**Decision.** Every pooled connection runs `SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED` through the pool's `initSql`, and a test pins it.
**Trade-off.** It applies to the whole application, not just the queue. Nothing here relies on repeatable reads (transactions are short and use conditional updates), and READ COMMITTED is the default in other major databases.

## D-18: The claim query pins its plan

**Context.** With the isolation fixed, three of four workers still claimed nothing. MySQL drove the join from `campaigns` with a filesort, which locks every due row before `LIMIT`.
**Decision.** `FORCE INDEX (idx_messages_status_run_at)` and `STRAIGHT_JOIN`, verified with `EXPLAIN` and a repeated concurrency test.
**Trade-off.** An optimiser hint is a maintenance cost, accepted because the alternative is a queue that silently serialises. The comment in `claim.ts` explains why.

## D-19: Contact deletion is erasure; suppression survives it

**Decision.** Deleting a contact cascades to its list memberships, recipients and messages. The `suppressions` row is independent of contacts and is kept, so someone who opted out cannot be mailed again by re-importing them.
**Alternative.** Keep message history with the contact link set to null. Rejected: a composite foreign key that includes `workspace_id` cannot be set to null, and keeping a deleted person's email in message rows contradicts erasure.

## D-20: Prisma client import extension

**Context.** The generated client imports siblings as `./enums.ts`. `tsc` copies the specifier into `dist`, and `node dist/server.js` failed to start. Found only by running the Docker image.
**Decision.** `importFileExtension = "js"` in the generator, plus a smoke test of the built server in CI.

## D-21: No repository layer per module

**Decision.** Services call Prisma directly. A repository file exists only where a query is complex enough to deserve one (`contacts.repository.ts`). The queue claim has its own module.
**Why.** For an application this size, a repository per module would be pass-through code. The rule that matters, that every query is scoped by workspace, is enforced by services taking `workspaceId` and by the database constraints.

## D-22: Time-zone arithmetic with `Intl`, no library

**Decision.** Sending-window and delay calculations use `Intl.DateTimeFormat` and a small offset-resolution function (`worker/schedule.ts`), covered by tests across daylight-saving changes and half-hour offsets.
**Alternative.** Luxon or date-fns-tz. Rejected to avoid a dependency for ~100 lines, at the cost of owning the DST edge cases. The tests found one real precision bug (dropped seconds).

## D-23: Frontend DOM through a text-only builder

**Decision.** `h(tag, props, ...children)` creates elements and only ever inserts strings as text nodes. There is no template literal HTML and no `innerHTML`.
**Why.** XSS prevention by construction rather than by remembering to escape, with a strict CSP as the second layer. The cost is more verbose view code than a framework would need.

## D-24: The fake provider simulates delivery events

**Decision.** In development, `EMAIL_PROVIDER=fake` mimics Resend's test-address convention and feeds the same event-processing function the webhook uses, after a short delay. Settings labels it "Simulated delivery".
**Why.** A developer or reviewer with no credentials can watch a campaign go through every status. It is clearly labelled and never selected implicitly.

## D-25: Bounce and complaint circuit breaker thresholds

**Decision.** After at least 20 accepted messages, a campaign pauses at a 3% bounce rate or a 0.08% complaint rate, and resuming needs explicit acknowledgement.
**Why.** Resend can suspend an account above 4% bounces or 0.08% complaints (read from its policy). A complaint threshold at the provider's own limit means a single complaint pauses a campaign under about 1,250 sends, which is intentional.

## D-26: Signed-out session probe is not an error

**Decision.** `GET /auth/session` returns 200 with `null` when signed out. `/auth/me` keeps returning 401.
**Why.** Every page load of a signed-out visitor was logging a 401 as a console error in the browser, which is noise that hides real problems.
