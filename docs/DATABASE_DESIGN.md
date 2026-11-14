# Database design

MySQL 8.4, InnoDB, `utf8mb4`. The schema is defined in [`prisma/schema.prisma`](../prisma/schema.prisma); the single migration also contains the integrity rules Prisma's schema language cannot express (CHECK constraints). This document describes what was built and why.

## Principles

1. **One source of truth per fact.** Whether an address may be emailed lives only in `suppressions`. Contacts have no second "unsubscribed" flag that could disagree with it.
2. **The database enforces tenancy**, not just the application. Cross-workspace links are impossible by constraint.
3. **Duplicates are prevented by unique keys**, never by "check first, then insert" alone.
4. **State is constrained.** Statuses are `ENUM`s, and transitions are conditional `UPDATE … WHERE status = ?`.
5. **Indexes exist for named queries** and were checked with `EXPLAIN` (below).
6. **Aggregates are computed from rows**, not stored.

## Tables

| Table                  | Purpose                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| `users`                | Login identity. Email unique and stored lower-cased                            |
| `sessions`             | Server-side sessions. Only the SHA-256 hash of the token is stored             |
| `workspaces`           | The tenant: sender identity, time zone, default sending window, daily limit    |
| `workspace_members`    | Membership and role (`owner`, `member`). Primary key `(workspace_id, user_id)` |
| `contacts`             | A person, with consent basis, source and time                                  |
| `contact_lists`        | Named group of contacts                                                        |
| `contact_list_members` | Contact on a list. Primary key `(list_id, contact_id)`                         |
| `suppressions`         | Addresses that must never be emailed, with a reason                            |
| `campaigns`            | Name, status, target list, start time, sending window, version                 |
| `campaign_steps`       | The ordered emails of a campaign: subject, body, delay in days                 |
| `campaign_recipients`  | One row per contact in a campaign, with their sequence state                   |
| `email_messages`       | One row per email. **This is the job queue**                                   |
| `webhook_events`       | Provider events, stored once each, for deduplication and audit                 |
| `activity_log`         | Append-only record of important actions                                        |

Not modelled on purpose: a reusable sequence entity (steps belong to a campaign), a separate enrolment table (that is `campaign_recipients`), an unsubscribe-event table (an unsubscribe is a suppression row plus an activity entry), and a job-metadata table (the queue is `email_messages`).

```mermaid
erDiagram
  users ||--o{ sessions : has
  users ||--o{ workspace_members : joins
  workspaces ||--o{ workspace_members : has
  workspaces ||--o{ contacts : owns
  workspaces ||--o{ contact_lists : owns
  workspaces ||--o{ suppressions : owns
  workspaces ||--o{ campaigns : owns
  workspaces ||--o{ activity_log : records
  contact_lists ||--o{ contact_list_members : contains
  contacts ||--o{ contact_list_members : "belongs to"
  contact_lists ||--o{ campaigns : "targeted by"
  campaigns ||--o{ campaign_steps : sequence
  campaigns ||--o{ campaign_recipients : enrols
  contacts ||--o{ campaign_recipients : "enrolled as"
  campaign_recipients ||--o{ email_messages : produces
  campaign_steps ||--o{ email_messages : "rendered as"
  email_messages ||--o{ webhook_events : "updated by (provider_message_id)"
```

## Tenant isolation through composite foreign keys

Parents expose `(workspace_id, id)` as a unique key, and tables that link two tenant-owned rows carry `workspace_id` and reference both parents through it:

```sql
CONSTRAINT contact_list_members_workspace_id_list_id_fkey
  FOREIGN KEY (workspace_id, list_id)    REFERENCES contact_lists (workspace_id, id) ON DELETE CASCADE,
CONSTRAINT contact_list_members_workspace_id_contact_id_fkey
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts      (workspace_id, id) ON DELETE CASCADE
```

A row linking workspace A's contact to workspace B's list cannot be inserted, whatever the application does. The same pattern covers `campaigns.list_id`, `campaign_recipients` (campaign and contact), and `email_messages` (campaign, recipient and step, where recipient and step must belong to the _same campaign_). Prisma 7 models these overlapping keys, and the integration tests insert the forbidden links directly and expect a foreign-key error.

## Constraints

**Unique keys**

| Key                                                             | Prevents                                                                           |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `users(email)`                                                  | Two accounts for one address                                                       |
| `contacts(workspace_id, email)`                                 | Duplicate contacts. Emails are lower-cased; the collation is also case-insensitive |
| `contact_lists(workspace_id, name)`                             | Two lists with one name                                                            |
| `suppressions(workspace_id, email)`                             | Duplicate suppression rows; inserting an existing one is a no-op                   |
| `campaign_recipients(campaign_id, contact_id)`                  | The same person enrolled twice in a campaign                                       |
| **`email_messages(recipient_id, step_id)`**                     | **Two emails for one step and one person: the core duplicate-send guard**          |
| `email_messages(provider_message_id)`                           | Two messages mapped to one provider id; lets a webhook find exactly one row        |
| `webhook_events(provider, provider_event_id)`                   | Reprocessing a redelivered webhook                                                 |
| `sessions(token_hash)`, `campaign_steps(campaign_id, position)` | Token collisions; two steps at one position                                        |

**CHECK constraints** (MySQL 8.0.16+ enforces them; added by hand in the migration)

- Emails in `users`, `contacts`, `suppressions` and `email_messages` are stored lower-cased (compared with a binary collation, since the default collation would make the check always true), and user and contact emails contain an `@`.
- Sending windows: start hour 0–23, end hour 1–24, start before end (on `workspaces` and `campaigns`). Daily limit 1–100,000.
- Step position ≥ 1; delay 0–60 days. Campaign `version` ≥ 1.
- `email_messages.attempts` between 0 and 10.
- **A `sending` message must have a lease** (`locked_by` and `locked_until`), and an `accepted`, `delivered`, `bounced` or `complained` message must have a `provider_message_id`.
- A `stopped` recipient must have a stop reason.

These are not decoration. Writing the seed script hit `chk_recipients_stop_reason` on the first run, which was a bug in the seed that application code would not have caught.

## Deleting data

| Parent deleted | Effect on children                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| user           | Their sessions cascade. Activity and campaigns they created keep their rows with the user set to null |
| workspace      | Everything it owns cascades                                                                           |
| contact        | List memberships, campaign recipients and their messages cascade. **The suppression is kept**         |
| list           | Memberships cascade. A list that a campaign targets cannot be deleted (`RESTRICT`)                    |
| campaign       | Only drafts can be deleted (steps cascade). A launched campaign is cancelled, not deleted             |

Deleting a contact is an erasure of that person's campaign history, deliberately: removing someone's data must not remove the fact that they opted out, which is why suppressions are independent of contacts. A previously unsubscribed person who is re-added is still suppressed (tested).

## Indexes and query plans

Each index exists for a named query. Plans were checked with `EXPLAIN` on a synthetic workspace of 50,000 contacts and 50,000 messages (`scripts/perf-dataset.sql`, `scripts/explain-queries.sql`).

| Query                                     | Plan                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Claim due messages                        | `idx_messages_status_run_at` range scan, no filesort; campaigns joined by primary key               |
| Contacts page, newest first               | Primary key scanned backwards with the workspace filter, stops at `LIMIT`                           |
| Contact search by email prefix            | `uq_contacts_ws_email`, index-only. Name and company search is a bounded scan within one workspace  |
| Contacts on a list with their suppression | `contact_list_members` primary key, then `contacts` and `suppressions` by unique key (one row each) |
| Campaign funnel (counts by status)        | `idx_messages_campaign_status`                                                                      |
| Webhook lookup by provider id             | Unique index `uq_messages_provider_id`                                                              |
| Session lookup on every request           | Unique index `uq_sessions_token_hash`                                                               |

**An index that was not added.** The analytics aggregate (counts of accepted, delivered and bounced over a date range) uses `idx_messages_ws_status` and a temporary table rather than `idx_messages_ws_accepted_at`. A covering index `(workspace_id, accepted_at, status)` was tried: the query stayed at about 21 ms on 50,000 messages either way, so the index was dropped rather than paying write overhead for no measured gain. Revisit if message volume grows by an order of magnitude.

## Transactions

| Operation         | Atomic unit                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Register          | user, workspace, owner membership, activity entry                                           |
| Launch campaign   | status change (with version check), recipient snapshot excluding suppressed, first messages |
| Claim messages    | `SELECT … FOR UPDATE SKIP LOCKED` and the update to `sending`                               |
| Record a send     | message to `accepted`, create the next step's message (or complete the recipient)           |
| Process a webhook | message status change, suppression insert, stop the recipient's remaining steps             |
| Unsubscribe       | suppression insert, skip pending messages, stop the recipient, activity entry               |
| CSV import        | per batch of 500: contact inserts and list memberships                                      |
| Cancel campaign   | status change, cancel pending messages, stop recipients                                     |

The call to the email provider is never inside a transaction.

## Concurrency findings

- **Isolation level.** At REPEATABLE READ the claim query deadlocked under four concurrent workers (InnoDB reported next-key locks on the status index). Setting READ COMMITTED on every pooled connection fixed it. Prisma's `isolationLevel` option was tried first and does nothing through the MariaDB adapter, which a test now pins down.
- **Query plan.** After that, the test still showed three of four workers claiming nothing. `EXPLAIN` showed MySQL starting from `campaigns` with a filesort, which locked every due row first. Forcing the index and join order fixed it, verified by running the concurrency test repeatedly.
- **Optimistic locking** on `campaigns.version` for draft edits, and **conditional updates** for status transitions. Simultaneous launches or pauses produce exactly one success and the rest get 409 (tested with parallel requests).

## Retention

Expired sessions and webhook payloads older than 30 days are cleaned by the worker's housekeeping (once an hour). Message history and the activity log are kept. Suppressions are kept indefinitely.

## Migrations

`npx prisma migrate dev` creates and applies migrations locally; `npx prisma migrate deploy` applies them in CI, tests and production. The initial migration is hand-extended with the CHECK constraints; `migrate dev` verifies against a shadow database that the result still matches the schema. IDs are `INT AUTO_INCREMENT` (about 2.1 billion rows per table, far above this project's needs, and Prisma's `Int` avoids `BigInt` JSON problems). Sequential IDs are guessable, so authorization never depends on ID secrecy.
