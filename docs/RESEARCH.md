# Cadentra: Phase 0 Research

Date of research: 2026-11-14. Status: proposal, awaiting review.

## How to read this document

Every claim carries one of these labels, because the difference matters when you defend a decision in an interview.

| Label              | Meaning                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| **Verified**       | I ran a command, queried a registry, or fetched the primary source during Phase 0        |
| **Secondary**      | Only seen in search-result summaries or third-party pages. Re-check before relying on it |
| **Recommendation** | My judgement, not a fact                                                                 |
| **Not verified**   | Stated from general knowledge. Must be checked before use                                |

## 1. Environment audit

All **Verified** by running the commands on this machine.

| Item         | Result                                                                         | Consequence                                                                |
| ------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Node.js      | v24.22.1                                                                       | Target Node 24 (see section 4.1)                                           |
| npm          | 11.19.1                                                                        | Use npm. No pnpm installed, and a second package manager adds nothing here |
| Git          | 2.54.0 (Apple Git-157)                                                         | Fine                                                                       |
| Git identity | `user.name` and `user.email` are set globally                                  | Commits will carry the global email. Check it is the one you want public   |
| MySQL        | Not installed                                                                  | Run MySQL in Docker (see below)                                            |
| Docker       | CLI 29.9.3 and Compose v5.7.0 are installed, but the **daemon is not running** | Start Docker Desktop before Phase 2                                        |
| Redis        | 8.10.3, installed through Homebrew                                             | Present, but not needed under the recommended design                       |
| `gh` CLI     | Not installed                                                                  | Cannot create PRs from the terminal                                        |
| GitHub auth  | No SSH key (`Permission denied (publickey)`), no credential helper configured  | **Pushing is currently blocked.** See the repository audit                 |

## 2. Repository audit

### Local directory: `/Users/ayush/Desktop/Cadentra`

**Verified.** The directory was completely empty (`ls -la` showed no entries) and not a Git repository. Nothing existed to preserve or overwrite.

### Remote: `https://github.com/Ayush-o1/Cadentra`

**Verified** through the unauthenticated GitHub REST API:

- Public repository, default branch `main`, created 2026-11-14.
- `size: 0`. The contents endpoint answers "This repository is empty" and the commits endpoint answers "Git Repository is empty". So there are no commits, no branches, and no existing work.
- A description is already set: "A backend-first outbound marketing platform for managing contacts, orchestrating email campaigns, scheduling automated outreach, and tracking campaign performance. Built with Node.js, TypeScript, and MySQL." Nothing in this plan contradicts it.
- No license, no topics.

### Consequences for the Git workflow

1. The remote has no `main` branch yet, so a pull request into `main` is impossible until `main` exists. `main` must be created by pushing one initial commit. That is a deliberate bootstrap step, and I will not do it without your go-ahead.
2. I cannot push from this machine until authentication exists. Options are in the Phase 0 report.

## 3. Product research

### What I actually inspected

I want to be precise here, since the brief forbids claiming research I did not do.

- **Verified:** I fetched the marketing home pages of Instantly, Smartlead and lemlist and read their navigation and product taxonomy. I did **not** see any of their in-app screens, because those sit behind a login.
- **Secondary:** Instantly's help center (campaign creation and campaign options articles), as shown in search snippets. The pre-launch checklist there lists: leads uploaded with variables mapped, sequence written, preview and test emails, sending accounts assigned, schedule and limits configured, then Launch.
- **Not inspected:** Mailchimp (page downloaded, not read), and the UI of every product named in the brief. The UI direction in `PRODUCT_REQUIREMENTS.md` is therefore **Recommendation**, informed by the taxonomy and by the checklist above, not by studying their screens.

### Observed vocabulary and workflow (Verified from the marketing sites, Secondary from help snippets)

Across Instantly, Smartlead and lemlist the product areas repeat: lead data, outreach sequences or campaigns, sending infrastructure and deliverability, a unified inbox, and (increasingly) AI agents. The campaign flow they describe is: leads, sequence, schedule, options, launch.

### What this product category implies (Recommendation)

- The product's centre of gravity is the **sequence**: ordered steps, delays between them, and per-contact state.
- Credibility comes from **honest delivery data and safe defaults**, not from the number of features.
- Most of what those companies sell (lead databases, mailbox warm-up, multi-mailbox rotation, AI agents, unified inbox, LinkedIn and calling) is out of scope for a student MVP and, in the case of warm-up and rotation, is built to evade spam filtering. Cadentra will not build that.

## 4. Engineering research

### 4.1 Runtime and language

| Finding                                                                                                                                       | Label    | Source                         |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------ |
| Node 24 ("Krypton"): LTS from 2025-10-28, maintenance from 2026-10-20, end of life 2028-04-30                                                 | Verified | `nodejs/Release/schedule.json` |
| Node 26 ("Lithium"): scheduled LTS from 2026-10-28, end of life 2029-04-30. Node 22 ends 2027-04-30. Node 20 reached end of life 2026-04-30   | Verified | same file                      |
| Express latest is 5.3.0, with a `latest-4` tag at 4.22.3. Express 5 requires Node 18 or later                                                 | Verified | npm registry                   |
| TypeScript `latest` is **7.0.2**, but `typescript-eslint` 8.72.2 declares the peer range `typescript >=4.8.4 <6.1.0`. The newest 6.x is 6.0.3 | Verified | npm registry                   |
| Zod latest is 4.6.7. Vitest latest is 5.1.0 (needs Node `^22.12 or ^24 or >=26`). ESLint latest is 10.15.0. Prettier is 3.10.1                | Verified | npm registry                   |

**Recommendation:** use Node 24 (your installed version, supported to April 2028, accepted by every dependency I checked). Node 26 is the newest LTS line on the schedule, but I have not checked that hosting providers offer it, so I would not adopt it yet. Pin **TypeScript 6.0.x**, because the current lint toolchain does not support TypeScript 7.

### 4.2 Database access

| Finding                                                                                                                                                            | Label        | Source                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ------------------------------------- |
| Prisma's npm `latest` tag points to `8.0.0-rc.33`, a **release candidate**. The `prev` tag is 7.10.1. `@prisma/client` 7.10.1 is the stable line                   | Verified     | npm registry                          |
| Prisma's docs state "Prisma ORM 7 remains fully supported". The index describes Prisma 8 as "a ground-up TypeScript rewrite"                                       | Verified     | `prisma.io/docs/llms.txt`             |
| In Prisma 7, MySQL uses `@prisma/adapter-mariadb` (the `mariadb` driver) with `prisma.config.ts` holding `datasource.url`. `prisma migrate dev` is fully supported | Verified     | Prisma v7 MySQL docs page             |
| `@prisma/adapter-mysql` does not exist on npm                                                                                                                      | Verified     | npm registry returned an error        |
| Prisma cannot express CHECK constraints, and a locking read such as `FOR UPDATE SKIP LOCKED` needs raw SQL                                                         | Not verified | General knowledge. Confirm in Phase 2 |
| `mysql2` 3.24.6 and Kysely 0.29.9 are current (Kysely needs Node 22 or later)                                                                                      | Verified     | npm registry                          |

**Recommendation:** Prisma **7.10.x pinned exactly**, because you already know Prisma and its generated types are a good way to learn TypeScript. Do not follow `latest`, since that is the release candidate. Hand-edit migration SQL for anything Prisma cannot express, and use `$queryRaw` for the queue claim and analytics. The serious alternative is Kysely plus plain SQL migrations. See DECISIONS D-04.

### 4.3 Background jobs: BullMQ and Redis versus a MySQL-backed queue

| Finding                                                                                                                                                                                                                    | Label                    | Source                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------ |
| BullMQ's production checklist: enable Redis persistence (AOF recommended), set `maxmemory-policy` to `noeviction`, auto-reconnect, log errors, shut workers down gracefully on SIGINT and SIGTERM, remove finished jobs    | Verified                 | docs.bullmq.io "Going to production" |
| Job `data` is stored in clear text in Redis                                                                                                                                                                                | Verified                 | same page                            |
| A worker killed mid-job leaves the job "stalled", and it is picked up after roughly 30 seconds by default                                                                                                                  | Verified                 | same page                            |
| BullMQ 6.7.6 is current. Its docs now list a **PostgreSQL backend**. There is no MySQL backend                                                                                                                             | Verified                 | npm registry and docs navigation     |
| MySQL 8.x supports `SELECT ... FOR UPDATE SKIP LOCKED`. A locked row is removed from the result set, and the manual says it "may be used to avoid lock contention when multiple sessions access the same queue-like table" | Verified                 | MySQL 8.4 manual, "Locking Reads"    |
| The same manual warns that SKIP LOCKED returns "an inconsistent view of the data" and is "not suitable for general transactional work"                                                                                     | Verified                 | same page                            |
| TiDB supports `SELECT FOR UPDATE`. I could **not** confirm `SKIP LOCKED` support at the time of writing. **Later resolved:** TiDB's compatibility page lists it as unsupported (see TIDB_COMPATIBILITY.md)                 | Secondary / Not verified | search results only                  |

**Recommendation:** a **MySQL-backed queue**, where the `email_messages` table is the queue. Reasons:

1. Domain state and queue state change in **one transaction**. With Redis you have a dual-write problem: the database says "scheduled" but the job never reached Redis, or the reverse.
2. One fewer piece of infrastructure to host, secure and keep persistent. BullMQ needs AOF and `noeviction`, which many hosted Redis offerings do not set by default.
3. It exercises the skills the job description asks for: transactions, locking, indexes, idempotency.
4. Email volume at this scale is a few thousand messages per day, which a polling worker handles easily.

Costs: polling latency, load on the primary database, and a more hand-written retry implementation. The message-processing function will be independent of the queue mechanism, so BullMQ remains a later option. See D-05.

### 4.4 Email provider (Resend)

All **Verified** from Resend's own documentation pages fetched on 2026-11-14 unless marked.

| Finding                                                            | Detail                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acceptable Use Policy                                              | Prohibits "sending unsolicited messages of any kind, including cold outreach, purchased lists, or scraped contact data". All mail must go to recipients who have "explicitly opted in". Bulk senders must include a valid address and company name, disclose why they are contacting the recipient, and honour opt-outs within 7 days |
| Account thresholds                                                 | Complaint rate must be lower than **0.08%**. Bounce rate must be lower than **4%**. Otherwise the account may be shut down without warning                                                                                                                                                                                            |
| Pricing and limits                                                 | Free plan: 3,000 emails per month and **100 per day**. Rate limit: **10 requests per second per team**, with `429` and `retry-after` when exceeded                                                                                                                                                                                    |
| Idempotency                                                        | `Idempotency-Key` header on `POST /emails`. Up to 256 characters. Remembered for **24 hours**. A repeated request returns the original response without sending again                                                                                                                                                                 |
| Webhooks                                                           | Signed through Svix. Verify with `resend.webhooks.verify` or the `svix` package using the **raw body** plus the `svix-id`, `svix-timestamp` and `svix-signature` headers. Events can be replayed from the dashboard                                                                                                                   |
| Events                                                             | `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`, `email.opened`, `email.clicked`, `email.scheduled`                                                                                                                                                |
| Event meaning                                                      | `email.sent` means "API request was successful" and Resend will attempt delivery. `email.delivered` means the recipient's mail server accepted it. `email.bounced` means permanently rejected                                                                                                                                         |
| Test addresses                                                     | `delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev`, `suppressed@resend.dev`. Labels work, for example `delivered+user1@resend.dev`                                                                                                                                                                                 |
| Blocked domains                                                    | Sending to `example.com` or `test.com` returns `422`                                                                                                                                                                                                                                                                                  |
| At-least-once delivery, dedupe on the event id                     | **Secondary** (third-party guides). Design for duplicates regardless                                                                                                                                                                                                                                                                  |
| Whether `onboarding@resend.dev` can only send to the account owner | **Not verified.** Check in Phase 7                                                                                                                                                                                                                                                                                                    |

**The important finding.** Resend's policy rules out the cold-outreach product that the brief's competitor list (Instantly, Smartlead) implies. Cadentra is therefore defined as **permission-based outreach**: every contact must carry a recorded consent basis. This is not a limitation to apologise for. It matches the brief's own compliance section ("no unsolicited mass-email behavior by default") and is easier to defend in an interview than a tool that pretends the policy does not exist.

Provider alternatives (Brevo, Amazon SES, SMTP through Nodemailer) were **not researched in depth**. The integration will sit behind one small interface so a second provider can be added.

### 4.5 Deliverability and compliance (Secondary)

All from vendor and blog pages, not from Google or Yahoo's own policy pages. Re-check against the primary sources before Phase 7.

- Gmail and Yahoo bulk-sender rules (the commonly reported threshold is about 5,000 messages per day to one provider): one-click unsubscribe through `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058), a visible unsubscribe link, spam rate below 0.3% (0.1% as a target), SPF, DKIM and DMARC.
- Cadentra will be far below the bulk threshold, but it will send both headers anyway. They are cheap and they are the correct behaviour.
- Bounce handling consensus: hard bounces are suppressed immediately. Repeated soft bounces are suppressed after a count. A temporary deferral is not suppression.

### 4.6 Authentication and web security

| Finding                                                                                                                                                                                                | Label                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| OWASP's Password Storage Cheat Sheet prefers Argon2id. The minimum commonly cited is 19 MiB memory, 2 iterations, 1 lane. I fetched the page link but only saw the figures through secondary summaries | Secondary                      |
| `argon2` 0.45.2 is current on npm                                                                                                                                                                      | Verified                       |
| Cookie guidance: `HttpOnly`, `Secure`, explicit `SameSite`, and the `__Host-` prefix. Seen in OWASP's testing guide and ASVS pages through search                                                      | Secondary                      |
| `helmet` 8.3.0, `express-rate-limit` 8.7.4, `pino` 10.4.0, `pino-http` 11.0.0, `csv-parse` 7.0.3, `svix` 2.10.0 (needs Node 22 or later), `resend` 6.38.1 are current                                  | Verified                       |
| Node 24 supports `--env-file`, so `dotenv` is unnecessary                                                                                                                                              | Not verified. Check in Phase 1 |

**Recommendation:** Argon2id through the `argon2` package, with `node:crypto` scrypt as the fallback if the native module fails to install on the hosting platform. Server-side sessions with an opaque random token (details in ARCHITECTURE).

### 4.7 Testing

| Finding                                                                                                  | Label                                  |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Vitest 5.1.0, Supertest 7.3.2 and Playwright 1.65.1 are current                                          | Verified                               |
| Testcontainers 12.2.1 requires Node 22.22 or later                                                       | Verified                               |
| A common pattern is Vitest plus Supertest against a real MySQL container, plus Playwright for end-to-end | Secondary                              |
| No official compatibility matrix for Vitest 5 on Node 24 was found                                       | Not verified. Phase 1 CI will prove it |

**Recommendation:** run MySQL as a Docker Compose service locally and as a GitHub Actions **service container** in CI. That tests against real MySQL without the extra Testcontainers dependency.

## 5. Hosting research (Secondary unless stated)

| Service            | Finding                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aiven              | Free MySQL is retired. Cheapest MySQL is the Developer tier at about $5/month, per Aiven's own page                                                                                                |
| TiDB Cloud Starter | The main free MySQL-compatible option: 5 GiB row storage, AWS only. It is MySQL-compatible, **not** MySQL. `SKIP LOCKED` support unconfirmed                                                       |
| Railway            | Roughly $5/month credit tiers. Sources conflict on whether a free tier exists. Usage-based MySQL estimated near $7/month                                                                           |
| Render             | Free web services **spin down after about 15 minutes idle** and take about a minute to restart. No free background worker. Paid instances start near $7/month. Free Postgres expires after 30 days |
| Fly.io             | About $2.19/month for a continuously running 256 MB machine. The old free allowance appears to be gone for new accounts                                                                            |

**What this means (Recommendation).** A queue worker that sleeps cannot send scheduled email. Two honest options: pay roughly $5 to $15 per month for always-on compute plus a real MySQL, or use free hosting and drive the worker from an external scheduled call to a protected `/internal/tick` endpoint. The MySQL-backed queue makes the second option possible, because all state lives in the database. Final choice is made in Phase 10 after a compatibility spike. See D-14.

## 6. Features intentionally excluded from the MVP

Open tracking and click tracking, reply detection, mailbox connection (Gmail or Outlook), warm-up, multi-mailbox rotation, lead database and enrichment, A/B testing, AI-written copy, a visual email editor, team invitations and roles beyond owner and member, per-workspace provider keys, billing, per-contact timezones, API keys and public API. Reasons are in `PRODUCT_REQUIREMENTS.md`.

## 7. Gaps in this research

- I did not read Mailchimp's pages or any competitor's in-app UI.
- I did not research email providers other than Resend.
- I did not read the OWASP cheat sheets directly. Security figures are from secondary summaries and must be checked in Phase 3.
- I did not verify whether Prisma can handle composite foreign keys that include a tenant column in every case I intend to use. This is the first spike in Phase 2.
- Pricing and free-tier terms change often. Re-check at deployment time.

## 8. References

- Node release schedule: https://github.com/nodejs/Release/blob/main/schedule.json
- Node API docs: https://nodejs.org/docs/latest/api/
- Express 5 migration: https://expressjs.com/en/guide/migrating-5
- Prisma ORM 7 and MySQL: https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/mysql
- MySQL locking reads: https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html
- BullMQ production guide: https://docs.bullmq.io/guide/going-to-production
- Resend webhooks: https://resend.com/docs/webhooks/introduction
- Resend webhook verification: https://resend.com/docs/webhooks/verify-webhooks-requests
- Resend event types: https://resend.com/docs/webhooks/event-types
- Resend idempotency keys: https://resend.com/docs/dashboard/emails/idempotency-keys
- Resend test addresses: https://resend.com/docs/knowledge-base/what-email-addresses-to-use-for-testing
- Resend rate limits: https://resend.com/docs/api-reference/rate-limit
- Resend pricing: https://resend.com/pricing
- Resend acceptable use policy: https://resend.com/legal/acceptable-use
- OWASP Password Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- OWASP Top Ten: https://owasp.org/www-project-top-ten/
- Instantly help center, creating a campaign: https://help.instantly.ai/en/articles/6386134-creating-a-campaign
- Aiven free MySQL status: https://aiven.io/free-mysql-database

## 9. Addendum: what implementation confirmed or changed

Added after the build. The original text above is left as written.

- **Confirmed.** Resend's policy, test addresses and idempotency documentation matched what the integration needed. `FOR UPDATE SKIP LOCKED` works on MySQL 8.4 for the claim pattern.
- **Corrected.** Prisma 7's MariaDB adapter does not apply the per-transaction `isolationLevel` option (section 4.2 did not anticipate this), and the generated client needs `importFileExtension = "js"` to run from compiled output. `svix`'s `verify` returns nothing on success.
- **Still unverified.** TiDB's behaviour for composite foreign keys, CHECK constraints and `SKIP LOCKED`; Render's free-tier behaviour; any hosting price; Resend's handling of an unverified account; Resend's webhook retry schedule. DEPLOYMENT.md lists the spike that settles the database question.
- **Typography.** Geist is available as an npm package under the SIL Open Font License, so it is self-hosted.
- **Dependency versions** were as listed in section 4 on 2026-11-14 and are pinned exactly in `package-lock.json`. `typescript` is held at 6.0.x because `typescript-eslint` does not yet support 7.
