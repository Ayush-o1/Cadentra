# Cadentra: Product Requirements

Status: implemented. Where the build differs from the original proposal, it is noted inline. Evidence for the claims here is in [RESEARCH.md](RESEARCH.md).

## 1. What Cadentra is

Cadentra is a permission-based outbound email platform for small sales and marketing teams. A team imports contacts it has consent to email, builds a multi-step email sequence, schedules it, and watches what happened to every message: accepted, delivered, bounced, complained or failed.

The name comes from _cadence_: the rhythm of a follow-up sequence. The product's core promise is that the numbers it shows are the numbers it can actually measure.

### What it is not

Cadentra is not a cold-email tool. It has no lead database, no scraping, no mailbox warm-up and no sender rotation. Resend, the chosen provider, prohibits cold outreach and purchased lists in its acceptable use policy, and the brief asks for safe defaults. Every contact must record where its consent came from.

## 2. Target users and use cases

| User                                        | Situation                                                           | What they do in Cadentra                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Founder or sales rep at a small B2B company | 40 people asked for a demo at a conference booth and signed a sheet | Import them with consent basis "Requested contact", run a 3-step follow-up over 10 days, stop automatically for anyone who unsubscribes or bounces |
| Marketer at a small SaaS                    | A waitlist of 800 sign-ups needs a launch sequence                  | Import the waitlist, send a 4-step launch sequence inside business hours, read delivery and bounce rates                                           |
| Customer success lead                       | New customers need an onboarding series                             | Add customers to a list, run a short sequence, check that nothing was sent to anyone who opted out                                                 |

## 3. Scope classification

### MVP (Phases 1 to 10)

| Area              | Included                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accounts          | Register, log in, log out, server-side sessions, profile, change password, list and revoke own sessions                                                                                                                  |
| Workspace         | One workspace created at registration. Members are `owner` or `member`. Sender identity (from name, from address, reply-to, postal address) and sending limits live here                                                 |
| Contacts          | Create, edit, delete. Email validation. Unique per workspace. Search by email and name. Filter by list and status. Cursor pagination. Consent basis and source recorded per contact                                      |
| Lists             | Create, rename, delete. Add and remove contacts                                                                                                                                                                          |
| CSV import        | Upload, validate each row, report created, duplicate and invalid rows with row numbers. Consent basis is required for the whole import                                                                                   |
| Suppression       | A single suppression list per workspace. Unsubscribe, hard bounce, complaint, and manual entries. Checked at send time, so a suppression takes effect even for already-scheduled messages                                |
| Campaigns         | Create, edit while draft, target one list, ordered steps with a subject, body and delay from the previous step, schedule a start, a sending window (hours and weekdays in the workspace timezone), pause, resume, cancel |
| Sending           | MySQL-backed queue, retries with backoff, idempotent sends, rate and daily limits, graceful shutdown, stale-lease recovery                                                                                               |
| Provider          | Resend, plus a fake provider for tests and local development                                                                                                                                                             |
| Delivery tracking | Signed webhook receiver, idempotent event storage, monotonic message status updates                                                                                                                                      |
| Unsubscribe       | Link in every message, `List-Unsubscribe` and one-click POST header, public confirmation page                                                                                                                            |
| Safety            | Auto-pause a campaign when its bounce rate crosses a threshold. Per-workspace daily cap. Postal address and sender identity required before launch                                                                       |
| Analytics         | Dashboard and campaign pages computed from real rows: contacts, active campaigns, messages scheduled, accepted, delivered, bounced, complained, failed, with date filters                                                |
| Audit             | Activity log for important actions                                                                                                                                                                                       |
| Settings          | Profile, sender identity, provider status (sandbox or live, daily quota), security (password, sessions)                                                                                                                  |

### Post-MVP (built only if time allows after the MVP is deployed and stable)

Click tracking, team invitations, per-workspace provider API keys with encryption at rest, saved email templates, merge-field fallbacks and a preview with sample contact, CSV export of campaign results, soft-bounce counting, contact tags and segments by rule, per-contact timezone sending, MySQL-backed rate-limit store.

### Future enhancements (not planned)

Open tracking (unreliable because of mail-client image prefetching, which is why it is excluded rather than deferred), reply detection and inbox, mailbox connection, A/B testing, AI copy assistance, visual editor, billing, public API keys, additional providers, BullMQ migration if volume demands it.

## 4. Message lifecycle

Each message is one row in `email_messages` with exactly one status. These are the states the system can truthfully distinguish.

| Status       | Meaning                                                                              | How we know                                    |
| ------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `scheduled`  | Waiting for its send time (or a retry time)                                          | We created it                                  |
| `sending`    | A worker holds a lease and is calling the provider                                   | Worker claimed it                              |
| `accepted`   | The provider's API accepted the request and returned an id. **This is not delivery** | HTTP success from Resend, `email.sent` webhook |
| `delivered`  | The recipient's mail server accepted the message                                     | `email.delivered` webhook                      |
| `bounced`    | Permanently rejected                                                                 | `email.bounced` webhook                        |
| `complained` | Delivered, then marked as spam                                                       | `email.complained` webhook                     |
| `failed`     | We gave up after retries or got a permanent provider error                           | Our own retry logic or `email.failed`          |
| `skipped`    | Not sent because the contact was suppressed or the campaign stopped                  | Send-time check                                |
| `cancelled`  | Campaign cancelled before the send                                                   | User action                                    |

`delivery_delayed` is recorded as an event but is not a status, because it is temporary.

**Delivery rate** is `delivered / accepted`. **Bounce rate** is `bounced / accepted`. Neither includes messages that never reached the provider. There is no open rate.

## 5. Campaign lifecycle

`draft` then `scheduled` (start time in the future) or `running`, then `completed`. A running campaign may be `paused` and resumed. `cancelled` is terminal. A campaign auto-paused by the bounce circuit breaker is `paused` with a recorded reason, so the owner sees why.

Transitions are enforced in one function and guarded by a conditional update (`WHERE status = ?`), so two concurrent requests cannot both succeed.

## 6. Compliance rules (enforced in code, not just documented)

1. A contact cannot be created without a consent basis (`requested_contact`, `existing_customer`, `signed_up`, `event_attendee`, `other_documented`). Import requires the same.
2. Launch is refused until the workspace has a sender name, a from address and a postal address.
3. Every message carries an unsubscribe link and the one-click headers.
4. The suppression check runs again at send time, immediately before the provider call.
5. A hard bounce or complaint suppresses the address automatically.
6. An unsubscribe is honoured immediately. Resend's policy allows 7 days. We do not use the allowance.
7. Resend's thresholds (complaint below 0.08%, bounce below 4%) are shown on the analytics page, and the circuit breaker acts before the bounce limit.
8. Deleting a contact keeps the suppression row, so a deleted person who opted out cannot be re-imported and mailed.

## 7. Non-functional requirements

- Passwords hashed with Argon2id. Sessions revocable.
- Every query that touches tenant data is scoped by workspace, and the database refuses cross-workspace links.
- The send path is safe to retry: a crash at any point cannot produce a duplicate email within the provider's 24-hour idempotency window.
- All lists are paginated. No unbounded queries.
- Keyboard accessible. Contrast meets WCAG AA. Reduced-motion respected.
- Test and lint gates on every phase.

## 8. UI and UX direction

This section is a **Recommendation**. It is informed by the product taxonomy I inspected, not by studying competitor screens.

### Personality

Calm, precise and trustworthy. The interface should feel like a well-kept ledger: dense where data needs to be dense, quiet everywhere else. Visual motif: evenly spaced marks, echoing a cadence, used sparingly (the step timeline in the sequence editor, the logo mark, the empty-state illustration style). Copy is plain and specific: "3 messages waiting for their send window", not "Awesome campaign!".

### Theme and palette

Light theme. Warm off-white page, white surfaces, a single deep pine accent, and a signal amber used only for "scheduled" and attention states. This deliberately avoids the default indigo and purple gradient look.

Contrast ratios below were **computed during Phase 0** with the WCAG relative-luminance formula.

| Token                  | Hex                   | Use                                      | Contrast                                        |
| ---------------------- | --------------------- | ---------------------------------------- | ----------------------------------------------- |
| `--bg-page`            | `#F7F6F2`             | Page background                          | n/a                                             |
| `--bg-surface`         | `#FFFFFF`             | Cards, tables, modals                    | n/a                                             |
| `--bg-subtle`          | `#EEEDE8`             | Table header, hovered row, neutral badge | n/a                                             |
| `--border`             | `#E4E1D8`             | Dividers, input borders                  | n/a                                             |
| `--text`               | `#1B211F`             | Primary text                             | 15.12:1 on page                                 |
| `--text-muted`         | `#555F5B`             | Secondary text                           | 6.12:1 on page                                  |
| `--text-faint`         | `#626B67`             | Placeholders, hints                      | 5.09:1 on the page background                   |
| `--primary`            | `#0F5C4D`             | Primary button, links, focus ring        | 7.90:1 on white                                 |
| `--primary-hover`      | `#0B4A3E`             | Hover and pressed                        | 10.18:1 on white                                |
| `--primary-soft`       | `#E3F1ED`             | Selected nav item, soft fills            | 6.80:1 with primary text                        |
| `--signal`             | `#B4540A`             | Scheduled and attention accents          | 4.98:1 on white                                 |
| `--success` / badge bg | `#1E7B4F` / `#E4F3EA` | Delivered                                | 5.25:1 on white; badge text `#14633D` is 6.35:1 |
| `--warning` / badge bg | `#8A5A0B` / `#FBF0D9` | Paused, delayed                          | 5.92:1 on white; badge text `#7A4F08` is 6.30:1 |
| `--error` / badge bg   | `#B42318` / `#FCE8E6` | Failed, bounced                          | 6.57:1 on white; badge text `#9A1C12` is 6.99:1 |
| `--info` / badge bg    | `#2B5FA8` / `#E6EEF9` | Accepted, informational                  | 6.35:1 on white; badge text `#244F8C` is 6.98:1 |

Every status badge pairs a colour with a text label and a small shape, so colour is never the only signal.

### Typography

Used: **Geist Sans** for the interface and **Geist Mono** for identifiers and numbers, self-hosted as WOFF2 files so there is no third-party font request and the content security policy stays tight. The package is published under the SIL Open Font License, and the variable font files are served from `/fonts` with the licence alongside. Fallback: the system UI font stack.

Scale (rem, base 16px): 0.75, 0.8125, 0.875 (body in tables), 1 (body), 1.125, 1.375, 1.75, 2.25. Tabular numerals for all numeric columns.

### Layout

Fixed left sidebar (collapses to a top bar and drawer below 900px), a slim page header with the page title and the primary action, then content in a max-width container. Tables are the main component. Spacing on a 4px base scale. Radius: 6px for inputs and buttons, 10px for cards and modals. Shadows only on overlays (menus, modals, toasts). Everything else is separated by borders.

### Components

Buttons (primary, secondary, quiet, danger, with loading and disabled states), inputs, selects, checkboxes, data table with sticky header and cursor pagination, status badges, tabs, modal, confirm dialog, toast, dropdown menu, empty state, skeleton loader, stat tile, small SVG charts. All are plain functions and CSS classes built on the tokens above.

### Motion principles

150 to 200ms eases for hover, menu, modal and toast. A subtle fade and 4px rise on route change. Skeleton shimmer for loading. No decorative loops. Everything is disabled under `prefers-reduced-motion: reduce`.

### Screens (MVP)

1. Sign in and create account
2. Dashboard
3. Contacts (table, search, filters, add and edit drawer, import dialog)
4. Lists
5. Campaigns (table with status badges)
6. Campaign builder (steps: Audience, Sequence, Schedule, Review and launch)
7. Campaign detail (status, per-step performance, message table, pause and resume)
8. Analytics
9. Suppression list
10. Settings (Profile, Sender identity, Email provider, Security)
11. Public unsubscribe page

Every button, form and nav item will have working behaviour in the phase that introduces it. A screen is not merged as a static mock.
