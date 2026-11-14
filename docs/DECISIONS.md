# Cadentra: Decision Log

All entries are **Proposed** until the Phase 0 review is approved. Each records the alternatives and the trade-off, because you should be able to defend them.

| ID | Decision | Status |
| --- | --- | --- |
| D-01 | Permission-based outreach, not cold email | Proposed |
| D-02 | Node 24 and TypeScript 6.0.x | Proposed |
| D-03 | Express 5, Zod 4 | Proposed |
| D-04 | Prisma 7.10 (pinned), raw SQL where needed | Proposed |
| D-05 | MySQL-backed queue instead of BullMQ and Redis | Proposed |
| D-06 | Resend, behind one small interface | Proposed |
| D-07 | Server-side sessions in MySQL, Argon2id | Proposed |
| D-08 | Workspace tenancy from day one, with composite foreign keys | Proposed |
| D-09 | Vanilla JS modules, no bundler, served by Express | Proposed |
| D-10 | Cursor pagination | Proposed |
| D-11 | Vitest, Supertest, Playwright, MySQL service container | Proposed |
| D-12 | CSV import as `text/csv` body, not multipart | Proposed |
| D-13 | Provider API key from environment, not per workspace | Proposed |
| D-14 | Hosting decided in Phase 10 after a spike | Proposed |
| D-15 | Steps belong to a campaign; no reusable sequence entity | Proposed |
| D-16 | No open tracking | Proposed |

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

## D-05: MySQL-backed queue instead of BullMQ and Redis

**Context.** See RESEARCH 4.3.
**Decision.** `email_messages` is the queue, claimed with `FOR UPDATE SKIP LOCKED` and a lease. Retries, backoff and idempotency are implemented by us.
**Alternatives.** BullMQ plus Redis (mature retries, delayed jobs and dashboards, but needs persistent Redis with `noeviction`, dual writes, extra hosting), Redis not needed at all.
**Trade-off.** More hand-written logic and polling latency (seconds), in exchange for transactional consistency, one fewer service, and a design that exercises transactions and locking. Message processing is a plain function, so a later move to BullMQ is contained.
**Revisit if.** Sustained volume exceeds what polling a single table handles, which is far beyond this project.

## D-06: Resend behind one small interface

**Decision.** `EmailProvider.send(message, idempotencyKey)`, with `ResendProvider` and `FakeProvider`. Webhooks verified through the Svix scheme.
**Alternatives.** Nodemailer with SMTP (provider-agnostic, but no delivery webhooks), Brevo or SES (not researched).
**Trade-off.** Resend has idempotency keys, delivery webhooks and test addresses, which the brief's delivery-state requirement needs. Its free plan is 100 emails per day, which is enough for a demo and not for real use.
**Open.** Sending to arbitrary real addresses needs a verified domain. A domain costs money. Test addresses work without one (to be confirmed in Phase 7).

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

## D-15: Steps belong to a campaign

**Decision.** `campaign_steps` belongs to one campaign. No reusable sequence entity.
**Alternatives.** `email_sequences` as a first-class, reusable object.
**Trade-off.** Fewer tables and a simpler UI. Reuse is a template feature, which is post-MVP.

## D-16: No open tracking

**Decision.** Opens are not measured, and no tracking pixel is added.
**Why.** The brief says to avoid analytics the system cannot reliably measure. Mail clients that prefetch images inflate opens. Skipping the pixel also removes a privacy concern. Resend does emit `email.opened`, and the schema will tolerate storing it later.
