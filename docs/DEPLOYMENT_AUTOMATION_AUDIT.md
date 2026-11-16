# Deployment automation audit

Written 2026-11-16, updated the same day after the deployment ran. It records what could be automated for hosting Cadentra at **₹0**, what was done, and what is still unverified.

Labels, used only when true:

- **VERIFIED LOCALLY**: executed on this computer and the result observed.
- **VERIFIED VIA API**: a provider API answered successfully and the resulting configuration was checked.
- **VERIFIED LIVE**: tested against the deployed application or a real hosted service.
- **DOCUMENTATION CONFIRMED**: official documentation says so; not tested on your account.
- **REQUIRES MY ACTION**: needs your account, approval or a secret.
- **NOT VERIFIED**: could not be tested.

## Result

**Cadentra is deployed and working: https://cadentra-3be838.onrender.com** (Render free web service, region Oregon, branch `chore/final-hardening`, TiDB Cloud database, Resend). Total cost: ₹0. No card was requested anywhere.

| Check, run against the live URL                                                                                                                           | Result                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Production smoke test (9 checks: health, readiness with a database query, headers, assets, anonymous access refused, unsigned webhook refused, and so on) | **VERIFIED LIVE**: all passed                             |
| Register, sender identity, CSV import, campaign, launch                                                                                                   | **VERIFIED LIVE**                                         |
| Queue sends through Resend; delivered, bounced and spam-report events arrive through the **real signed webhook**                                          | **VERIFIED LIVE** (twice: 3 delivered/bounced/complained) |
| Bounced and complained addresses suppressed automatically                                                                                                 | **VERIFIED LIVE**                                         |
| Password-reset request accepted                                                                                                                           | **VERIFIED LIVE** (202). The email itself was not read    |
| Client IP behind Render's proxies                                                                                                                         | **VERIFIED LIVE**, and it found a bug: see below          |
| `POST /internal/tick` accepts the token (200) and rejects a wrong one (401)                                                                               | **VERIFIED LIVE**                                         |
| Free plan, no auto-deploy                                                                                                                                 | **VERIFIED VIA API** (`plan: free`)                       |

Only `@resend.dev` test addresses were ever emailed.

### Findings from the live run

1. **`TRUST_PROXY=1` was wrong on Render.** The app saw `10.27.5.133` (internal). With `2` it saw a Cloudflare address. **With `3` it sees the real client**, and a forged `X-Forwarded-For: 1.2.3.4` header was ignored. The blueprint, script and docs now say 3. Without this check, every visitor would have shared rate-limit buckets.
2. **TiDB behaves as the audit predicted, on the real thing** (TiDB v8.5.3 serverless, TLS verified):
   - Foreign keys (23 of them) are created and **enforced**; cross-tenant inserts are rejected; cascades work; unique keys, case-insensitive collation, transactions and `READ COMMITTED` work.
   - **The 14 `CHECK` constraints are silently ignored** (the migration succeeds, zero `CHECK` constraints exist afterwards). The application validates the same rules itself.
   - **`FOR UPDATE SKIP LOCKED` fails** (TiDB misreads the table alias in `FOR UPDATE OF m`), so `QUEUE_CLAIM_MODE=conditional-update` is required there, as configured.
   - The conditional-update claim gave 4 concurrent workers 120 of 120 rows, with no duplicates.
   - `prisma migrate deploy` ran on TiDB through `?ssl=true` and applied both migrations.
3. **The driver's default connect timeout of 1 second fails against a hosted database.** Fixed (10 s).
4. **The old wake workflow on `main` runs every 5 minutes.** That would keep the free service awake all month and could use up the 750 free hours Render shares across your whole workspace. It is **disabled** until the hourly version (on this branch) reaches `main`.

## What is available in this environment

| Integration                        | Status                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Render CLI 2.34.0                  | **VERIFIED LIVE**: logged in; created and inspected the service. Cannot edit environment variables of an existing service                       |
| Render connector (Claude Settings) | **VERIFIED LIVE**: available in the follow-up session. Used to change `TRUST_PROXY` (`update_environment_variables`), which triggers a redeploy |
| Render agent skills                | Installed at user scope                                                                                                                         |
| GitHub CLI                         | **VERIFIED LIVE**: set repository secrets, disabled a workflow. Repository is public, so Actions are free                                       |
| Resend API                         | **VERIFIED VIA API**: with your full-access key it created the sending-only key and the webhook                                                 |
| TiDB Cloud Zero API (no account)   | **VERIFIED VIA API**: created the database. The documented CLI and API for permanent clusters need an account login, so they were not used      |

## Architecture decision

Kept **Render + TiDB + Resend + GitHub Actions**. Alternatives: Aiven no longer offers free MySQL (official notice: no new free services since 2026-11-06, existing ones deleted 2026-12-21); free Render Postgres expires after 30 days and would mean rewriting the database layer; Koyeb's free instance sleeps after an hour and its card requirement could not be confirmed. Other hosts were not tested; they are generally card- or trial-based. That last point is a judgement, not a comparison.

### Free-tier facts (official documentation)

| Service        | Free limits that matter                                                                                                                                                  | Charges possible?                                                                                                 | Source                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Render web     | 750 free instance hours per workspace per month, **shared**; sleeps after 15 idle minutes (about a minute to wake); no SMTP ports; may restart at any time               | Exceeding the hours **suspends** free services. Bandwidth or build-minute overage bills only if a card is on file | <https://render.com/docs/free>                                                                   |
| TiDB Starter   | 5 GiB row storage, 50 million request units a month, 400 connections, 30-minute transactions. At quota it **rejects new connections**                                    | Only if you raise the spending limit above 0. Leave it at 0                                                       | <https://docs.pingcap.com/tidbcloud/serverless-limitations/>                                     |
| TiDB Zero      | Account-free, **expires 2026-12-16 unless claimed**; claiming turns it into a Starter instance                                                                           | None without an account                                                                                           | <https://zero.tidbcloud.com/> (PingCAP's own site; not on docs.pingcap.com)                      |
| Resend         | 100 emails a day (UTC), 3,000 a month, **one** webhook endpoint, 10 requests a second. Without a verified domain, only your own address and test addresses can be mailed | No card needed                                                                                                    | <https://resend.com/docs/knowledge-base/account-quotas-and-limits>, <https://resend.com/pricing> |
| GitHub Actions | Unlimited for public repositories                                                                                                                                        | No                                                                                                                | GitHub documentation (repository confirmed public with `gh`)                                     |

## Task table

| Task                                                   | Can Claude automate it?       | Integration / tool                    | Current status                                                                                                                     | My intervention required                                     |
| ------------------------------------------------------ | ----------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Create the Render service (free, Docker, health check) | Yes                           | `scripts/deploy/render-deploy.mjs`    | **VERIFIED LIVE**: `srv-dbtf8t1srm7s73b4o2p0`, plan free                                                                           | None                                                         |
| Change Render environment variables later              | Yes                           | Render connector                      | **VERIFIED LIVE** (`TRUST_PROXY`)                                                                                                  | None                                                         |
| Deploy, wait, read logs                                | Yes                           | Render CLI                            | **VERIFIED LIVE**: migrations applied, server listening                                                                            | None                                                         |
| Provision a database                                   | Yes                           | TiDB Cloud Zero API                   | **VERIFIED VIA API**; approved by you                                                                                              | **Claim it within 30 days** (see the manual setup)           |
| Compatibility check, migrations, DB tests on TiDB      | Yes                           | `db:compat`, `migrate deploy`, vitest | **VERIFIED LIVE** (see findings). The full integration suite was too slow over the internet to run in full; see the note below     | None                                                         |
| Resend sending key and webhook                         | Yes, with one full-access key | `scripts/deploy/resend-setup.mjs`     | **VERIFIED LIVE**: webhook signatures validated on real deliveries                                                                 | Delete the full-access key afterwards                        |
| Live send check, test addresses only                   | Yes                           | `scripts/deploy/verify-live.mjs`      | **VERIFIED LIVE**                                                                                                                  | None                                                         |
| GitHub secrets `APP_URL`, `TICK_TOKEN`                 | Yes                           | `gh secret set` (stdin)               | **VERIFIED LIVE**: both exist                                                                                                      | None                                                         |
| Hourly wake-and-tick workflow                          | Partly                        | GitHub Actions                        | The hourly version is on the branch only; GitHub runs schedules from `main`. The old 5-minute version is **disabled**. **Not run** | Merge PR #1, then enable the workflow (manual setup, step 2) |
| Merge PR #1 to `main`                                  | **No, by your rule**          | GitHub                                | Not done                                                                                                                           | Your decision                                                |
| Verified sending domain                                | No (costs money)              | Resend, DNS                           | Not done on purpose                                                                                                                | None                                                         |

**TiDB test note.** Over the internet every test takes 5 to 25 seconds instead of milliseconds, so the 178-test integration suite did not finish in a reasonable time. What did run on TiDB, with timeouts raised: `database.test.ts`, whose uniqueness, foreign-key, cascade, transaction and isolation tests passed. The failures were exactly the predicted ones: 4 `CHECK` tests (constraints not enforced) and the `skip-locked` claim tests (unsupported). A second run of the worker and conditional-update tests produced no result within a reasonable time and was stopped, so **the worker test files were not completed on TiDB (NOT VERIFIED)**. The conditional-update claim itself was checked by the `db:compat` concurrency test (4 workers, 120 of 120 rows, no duplicates), and the deployed worker sent real campaign emails through it (see the table above). The whole suite does pass on MySQL 8.4 in `conditional-update` mode, locally and in CI.

## Risks that remain

- **Free-hours sharing on Render.** Check <https://dashboard.render.com/billing#included-usage> after a week.
- **TiDB request units.** At a 10-second poll the worker's usage was not measured; the TiDB console shows it. At quota, new connections are refused.
- **Resend without a domain** can only mail your own address and test addresses. Confirmation and reset emails to other people will fail (the app logs it and carries on). `REQUIRE_VERIFIED_EMAIL` is therefore off.
- **CHECK constraints are not enforced on TiDB.**
- The worker only runs while the service is awake; scheduled sends wait for the next wake.
- Throwaway accounts from the live checks (`delivered+verify-…@resend.dev`) remain in the live database.

## Documentation used

- <https://render.com/docs/free>, <https://render.com/docs/cli>, <https://render.com/docs/api>, <https://render.com/docs/blueprint-spec>, <https://render.com/docs/mcp-server>
- <https://docs.pingcap.com/tidbcloud/serverless-limitations/>, <https://zero.tidbcloud.com/>
- <https://resend.com/docs/api-reference/webhooks/create-webhook>, <https://resend.com/docs/api-reference/api-keys/create-api-key>, <https://resend.com/docs/knowledge-base/account-quotas-and-limits>, <https://resend.com/docs/api-reference/errors>
- <https://aiven.io/docs/products/mysql/concepts/mysql-free-tier>
- [TIDB_COMPATIBILITY.md](TIDB_COMPATIBILITY.md)
