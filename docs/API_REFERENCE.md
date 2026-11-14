# API reference

Base path `/api/v1`. JSON in and out unless noted. The interactive app uses only these endpoints.

## Conventions

**Authentication.** A session cookie set by register or login (`cadentra_sid`, or `__Host-cadentra_sid` over https). Routes marked 🔒 require it and return 401 `UNAUTHENTICATED` without one.

**Tenancy.** The workspace is taken from the session. A resource that belongs to another workspace returns 404.

**Writes.** `POST`, `PUT`, `PATCH` and `DELETE` are checked against cross-site requests: a browser `Origin` must match the host (or `Sec-Fetch-Site` must be `same-origin`), and a request with a body must be `application/json` (or `text/csv` for the import). Otherwise 403 `CSRF_REJECTED` or 415 `UNSUPPORTED_MEDIA_TYPE`.

**Responses.** Success is `{ "data": … }`, with `"meta": { "nextCursor": string | null }` on paginated lists. Errors are:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "…",
    "details": [{ "path": "email", "message": "…" }]
  }
}
```

All API responses carry `Cache-Control: no-store`.

**Pagination.** List endpoints take `limit` (1–100, default 25) and an opaque `cursor`. Pass the previous response's `meta.nextCursor` to get the next page; `null` means the end. Results are newest first.

**Status codes.** 200, 201, 204; 400 malformed; 401 not signed in; 403 not allowed; 404 not found; 409 conflict; 413 body too large; 415 wrong content type; 422 validation failed; 429 rate limited.

**Error codes** (non-exhaustive): `VALIDATION_FAILED`, `INVALID_CREDENTIALS`, `EMAIL_TAKEN`, `CONTACT_EXISTS`, `LIST_EXISTS`, `LIST_IN_USE`, `SUPPRESSION_LOCKED`, `VERSION_CONFLICT`, `CAMPAIGN_LOCKED`, `INVALID_TRANSITION`, `LAUNCH_BLOCKED`, `INVALID_TOKEN`, `BOUNCE_RATE_ACK_REQUIRED`, `INVALID_CURSOR`, `RATE_LIMITED`, `CSRF_REJECTED`.

## Auth and account

| Method and path                       | Notes                                                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /auth/register`                 | `{ name, email, password (10–128), workspaceName? }` → 201 identity, sets the cookie. 409 `EMAIL_TAKEN`                                                                                                |
| `POST /auth/login`                    | `{ email, password }` → identity. Wrong email and wrong password give the same 401. Rate limited per IP and per account                                                                                |
| `POST /auth/forgot-password`          | `{ email }` → 202 `{ accepted: true }` **whether or not the address has an account**. Emails a one-hour link. Rate limited per IP (10 an hour) and per address (3 an hour)                             |
| `POST /auth/reset-password`           | `{ token, newPassword }` → 204. The token is single use; 400 `INVALID_TOKEN` if unknown, expired, used or of another kind. Signs out every session of the account and counts as confirming the address |
| `POST /auth/verify-email`             | `{ token }` → 204. 400 `INVALID_TOKEN` as above. Tokens last 24 hours                                                                                                                                  |
| `POST /account/verification-email` 🔒 | 202 `{ sent }`; `sent` is false when the address is already confirmed. Limited to 5 an hour                                                                                                            |
| `POST /auth/logout`                   | 204, clears the cookie                                                                                                                                                                                 |
| `GET /auth/session`                   | 200 with the identity, or `{ "data": null }` when signed out. Used on every page load                                                                                                                  |
| `GET /auth/me` 🔒                     | The identity, or 401                                                                                                                                                                                   |
| `PATCH /account/profile` 🔒           | `{ name }`                                                                                                                                                                                             |
| `POST /account/password` 🔒           | `{ currentPassword, newPassword }` → 204. Signs out every other session                                                                                                                                |
| `GET /account/sessions` 🔒            | Your sessions, with `current` flagged                                                                                                                                                                  |
| `DELETE /account/sessions/:id` 🔒     | Revoke one of your sessions                                                                                                                                                                            |

Identity: `{ user: { id, email, name, emailVerified }, workspace: { id, name, role } }`.

The reset and confirmation emails link to `/reset-password#token=…` and `/verify-email#token=…`. The secret is in the URL _fragment_, which browsers never send to a server, so it stays out of access logs and `Referer` headers; the pages read it with JavaScript, post it to the endpoints above, and remove it from the address bar.

## Workspace

| Method and path       | Notes                                                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /workspace` 🔒   | Settings, `sentToday`, `launchBlockers` (what is missing before a campaign may launch), and `provider: { name, simulated }`                                                                                |
| `PATCH /workspace` 🔒 | Owner only. Any of: `name`, `timezone` (IANA), `senderName`, `senderEmail`, `replyToEmail`, `postalAddress`, `windowStartHour` (0–23), `windowEndHour` (1–24), `weekdaysOnly`, `dailySendLimit` (1–100000) |

## Contacts

| Method and path            | Notes                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /contacts` 🔒         | Query: `search` (email prefix, or name/company contains), `listId`, `status` = `all` \| `active` \| `suppressed`, `cursor`, `limit`. Each item includes `suppressionReason` and `lists`                                                                                                                                                                                                                          |
| `POST /contacts` 🔒        | `{ email, firstName?, lastName?, company?, consentBasis, consentSource?, consentedAt?, listIds? }`. `consentBasis` is required: `requested_contact`, `existing_customer`, `signed_up`, `event_attendee`, `other_documented`. 409 `CONTACT_EXISTS`                                                                                                                                                                |
| `GET /contacts/:id` 🔒     |                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PATCH /contacts/:id` 🔒   | Any of the create fields except `listIds`                                                                                                                                                                                                                                                                                                                                                                        |
| `DELETE /contacts/:id` 🔒  | 204. Erases the contact's campaign history; the suppression, if any, is kept                                                                                                                                                                                                                                                                                                                                     |
| `POST /contacts/import` 🔒 | Body is the CSV text with `Content-Type: text/csv`. Query: `consentBasis` (required), `source?`, `listId?`. Needs an `email` column; `first_name`, `last_name`, `company` and common aliases are recognised. Up to 5,000 rows and 5 MB. Returns `{ totalRows, created, duplicates, invalid, suppressed, addedToList, errors: [{ row, email, message }], errorsTruncated }`; `row` is the line number in the file |

## Lists

| Method and path                           | Notes                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /lists` 🔒                           | With `contactCount`                                                                     |
| `POST /lists` 🔒                          | `{ name }`. 409 `LIST_EXISTS`                                                           |
| `GET /lists/:id` · `PATCH /lists/:id` 🔒  | `PATCH` renames                                                                         |
| `DELETE /lists/:id` 🔒                    | 409 `LIST_IN_USE` if a campaign targets it                                              |
| `POST /lists/:id/members` 🔒              | `{ contactIds: number[] (1–1000) }` → `{ added }`. Already-present contacts are skipped |
| `DELETE /lists/:id/members/:contactId` 🔒 | 204                                                                                     |

## Suppression list

| Method and path               | Notes                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /suppressions` 🔒        | Query `search`. Items: `{ id, email, reason, createdAt }` with reason `unsubscribed`, `hard_bounce`, `complaint` or `manual` |
| `POST /suppressions` 🔒       | `{ email }`. Adds a manual entry (idempotent) and cancels pending emails to that address                                     |
| `DELETE /suppressions/:id` 🔒 | Manual entries only. 409 `SUPPRESSION_LOCKED` for unsubscribes, bounces and complaints                                       |

## Campaigns

| Method and path                  | Notes                                                                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /campaigns` 🔒              | Query `status`, `search`. Each item has `counts` (recipients and per-status message counts)                                                                |
| `POST /campaigns` 🔒             | `{ name, listId?, startAt?, windowStartHour?, windowEndHour?, weekdaysOnly? }`. The window defaults to the workspace's                                     |
| `GET /campaigns/:id` 🔒          | Includes `steps` (each with per-status counts) and, for drafts, `launch: { blockers, eligibleRecipients }`                                                 |
| `PATCH /campaigns/:id` 🔒        | Drafts only. `{ version, …fields }`. 409 `VERSION_CONFLICT` if the draft changed since you read it                                                         |
| `PUT /campaigns/:id/steps` 🔒    | Drafts only. `{ version, steps: [{ subject, body, delayDays }] }` (1–10). Replaces the sequence; the first delay is ignored. Unknown merge fields give 422 |
| `DELETE /campaigns/:id` 🔒       | Drafts only (409 `CAMPAIGN_LOCKED` otherwise)                                                                                                              |
| `POST /campaigns/:id/preview` 🔒 | `{ position, contactId? }` → rendered subject and body, with sample data when no contact is given                                                          |
| `GET /campaigns/:id/messages` 🔒 | Query `status`. Items: recipient, step, status, times, attempts, last error                                                                                |
| `POST /campaigns/:id/launch` 🔒  | `{ version }`. 422 `LAUNCH_BLOCKED` with each reason in `details`                                                                                          |
| `POST /campaigns/:id/pause` 🔒   | From `scheduled` or `running`                                                                                                                              |
| `POST /campaigns/:id/resume` 🔒  | `{ acknowledgeBounceRate? }`. After an automatic pause this must be `true`, otherwise 409 `BOUNCE_RATE_ACK_REQUIRED`                                       |
| `POST /campaigns/:id/cancel` 🔒  | Final. Pending messages are cancelled                                                                                                                      |

Merge fields: `{{first_name}}`, `{{last_name}}`, `{{company}}`, `{{email}}`, optionally with a fallback: `{{first_name|there}}`.

## Analytics

| Method and path     | Notes                                                                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /dashboard` 🔒 | Current counts, the last 30 days of delivery, a daily trend, recent campaigns and activity                                                                                                                                                            |
| `GET /analytics` 🔒 | Query `range` = `7d` \| `30d` \| `90d` (default `30d`), or `from` and `to` together (at most one year), and optional `campaignId`. Returns `totals`, `rates`, `limits`, a gap-free daily `series`, `campaigns`, and `steps` when a campaign is chosen |

`totals`: `accepted` (the provider took it), `delivered` (reached the recipient's mail server; a message later reported as spam was delivered first), `bounced`, `complained`, `awaiting` (accepted, no result yet), `failed` (never accepted). Rates are measured against `accepted` and are `null`, not 0, when nothing was sent. Periods are UTC days and use when the message was accepted.

## Public endpoints

| Method and path                             | Notes                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /public/unsubscribe/:token`            | The masked address and sender name, for the unsubscribe page                                                                                                             |
| `POST /public/unsubscribe/:token`           | Unsubscribes. Idempotent. A forged or malformed token is 404                                                                                                             |
| `POST /u/:token` (outside `/api/v1`)        | RFC 8058 one-click unsubscribe, as sent by mail clients: no cookies, no Origin, form-encoded body ignored                                                                |
| `POST /webhooks/resend` (outside `/api/v1`) | Resend (Svix) webhooks. Verifies the signature over the raw body. 400 `INVALID_SIGNATURE` otherwise; responds `{ status: applied \| duplicate \| unmatched \| ignored }` |
| `POST /internal/tick` (outside `/api/v1`)   | `Authorization: Bearer $TICK_TOKEN`. Runs the worker once. 404 unless `TICK_TOKEN` is set                                                                                |
| `GET /healthz`, `GET /readyz`               | Liveness, and readiness (checks the database)                                                                                                                            |
