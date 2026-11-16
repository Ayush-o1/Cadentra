# Deployment

**Status: not deployed.** No hosting accounts, credentials or Resend keys were available, and the brief rules out paid services without approval. This document records exactly what has been verified, what has not, and the steps to finish. The ordered, account-dependent checklist is [FINAL_MANUAL_SETUP.md](FINAL_MANUAL_SETUP.md); the free database's compatibility is audited in [TIDB_COMPATIBILITY.md](TIDB_COMPATIBILITY.md).

## What has been verified

On a development machine, with Docker:

- The production image builds (`docker build -t cadentra .`), runs as the unprivileged `node` user, applies migrations to an empty MySQL database on start, reports `healthy` through its `HEALTHCHECK`, and passes `scripts/smoke-test.mjs` (health, readiness, security headers, static assets, SPA fallback, `no-store` API, anonymous access refused, unsigned webhook refused, bad unsubscribe link refused).
- **`docker-compose.prod.yml` was brought up end to end** (app plus its own MySQL, with throwaway secrets): the compose file validates, both migrations apply, the smoke test passes, a restart does not re-apply migrations, and `docker stop` ends the process in under a second with exit code 0 and "Shutting down" and "Worker stopped" in the log. This found a real bug, now fixed: the shell wrapper in `CMD` was PID 1 and swallowed SIGTERM, so the container was killed after the grace period (exit 137). CI repeats the run and the stop check on every push.
- **TLS to the database.** `?ssl=true` is honoured by both the application and `prisma migrate` (`prisma.config.ts` translates it for Prisma's engine). Checked against MySQL's self-signed certificate: verification is really on, and `?sslaccept=accept_invalid_certs` connects with TLS in use. It was not run against a real hosted database.
- The compiled output runs under plain `node dist/server.js` (this found and fixed a production-only bug; see TESTING.md).
- Config validation: the process exits with a clear message when required variables are missing, and refuses an `http` `APP_URL` in production.
- CI is set up to build the image and smoke-test the built server on every push. Its first run happens when the branch is pushed.

## What has not been verified

- **Any hosting provider.** `render.yaml` and `docker-compose.prod.yml` are written but have never run on those platforms.
- **Real email.** Resend has not been contacted. The send path is tested with a mocked HTTP client and the webhook path with locally signed payloads.
- **A hosted MySQL.** In particular TiDB Cloud Starter, the free MySQL-compatible option found in research, is _compatible_, not identical. The audit against TiDB's documentation found that **`SKIP LOCKED` is unsupported** (a second claim mode was added for it) and that **CHECK constraints are off by default**; foreign keys and Read Committed are documented as supported. None of this has run on TiDB. [TIDB_COMPATIBILITY.md](TIDB_COMPATIBILITY.md) has the findings and the exact verification commands.
- Memory and CPU needs. They were not measured.

## Configuration

All configuration is environment variables. The server validates them at startup.

| Variable                                                              | Required           | Notes                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                            | yes                | `production`                                                                                                                                                                                  |
| `DATABASE_URL`                                                        | yes                | `mysql://user:pass@host:3306/db`. Add `?ssl=true` if the provider requires TLS                                                                                                                |
| `APP_URL`                                                             | yes                | Public `https://…` address, no trailing path. Used in unsubscribe links and to decide cookie security                                                                                         |
| `APP_SECRET`                                                          | yes                | At least 32 random characters (`openssl rand -hex 32`). Changing it invalidates existing unsubscribe links                                                                                    |
| `TRUST_PROXY`                                                         | behind a proxy     | Number of reverse proxies in front of the app: `1` on Render, Railway, Fly, Caddy or nginx. `true` means 1. Check it after deploying (Settings, Security, Sessions shows the IP the app sees) |
| `QUEUE_CLAIM_MODE`                                                    | no                 | `skip-locked` (default, MySQL 8) or `conditional-update` (TiDB, or any database without `SKIP LOCKED`)                                                                                        |
| `SYSTEM_EMAIL_FROM`                                                   | with `resend`      | Sender of password-reset and confirmation mail, e.g. `Cadentra <onboarding@resend.dev>`                                                                                                       |
| `REQUIRE_VERIFIED_EMAIL`                                              | no (default false) | `true` makes a confirmed email address a launch requirement                                                                                                                                   |
| `EMAIL_PROVIDER`                                                      | yes                | `resend` for real sending. `fake` sends nothing                                                                                                                                               |
| `RESEND_API_KEY`                                                      | with `resend`      | From the Resend dashboard                                                                                                                                                                     |
| `RESEND_WEBHOOK_SECRET`                                               | with `resend`      | The signing secret (`whsec_…`) of the webhook you create                                                                                                                                      |
| `RUN_WORKER`                                                          | no (default true)  | Run the send worker in the web process                                                                                                                                                        |
| `WORKER_POLL_MS`, `WORKER_CONCURRENCY`, `WORKER_MAX_SENDS_PER_SECOND` | no                 | Defaults are 5000, 2 and 5. Resend allows 10 requests per second per team                                                                                                                     |
| `TICK_TOKEN`                                                          | optional           | At least 24 characters. Enables `POST /internal/tick` (see below)                                                                                                                             |
| `PORT`, `LOG_LEVEL`                                                   | no                 | Default 3000 and `info`                                                                                                                                                                       |

A blank value (`KEY=`) counts as unset. `.env.production.example` is a template for the self-hosted compose file. Never commit real values.

## Setting up Resend

1. Create a Resend account and an API key.
2. **Sending to real people needs a verified domain** (SPF and DKIM records), which means owning a domain. That is a cost this project does not assume. Whether Resend lets an unverified account send only to its own address through `onboarding@resend.dev` was not confirmed during research; check Resend's documentation.
3. Without a domain you can still exercise the whole integration with Resend's test addresses (`delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev`, and labelled variants such as `delivered+a@resend.dev`). Import them as contacts and run a campaign: you should see delivered, bounced and spam outcomes arrive through the webhook.
4. In Resend, add a webhook for all email events pointing at `https://<APP_URL host>/webhooks/resend`. Copy its signing secret into `RESEND_WEBHOOK_SECRET`.
5. Set `SYSTEM_EMAIL_FROM` for password-reset and confirmation mail (the same `onboarding@resend.dev` works for the account owner's own address).
6. **Live check.** `npm run resend:live` (see [FINAL_MANUAL_SETUP.md](FINAL_MANUAL_SETUP.md)) sends three emails to Resend's test addresses only, repeats one with the same idempotency key to confirm no duplicate is sent, and probes the key-conflict error. It refuses to run unless `RESEND_API_KEY` is set in your shell and `RESEND_LIVE_TEST_CONFIRM=send-test-emails` is given, and it never prints the key.
7. In Cadentra, Settings → Sender identity: set the sender name, an address on your verified domain, and a postal address. The free Resend plan allows 100 emails a day, so keep the daily limit at or below that.

Never send test campaigns to real addresses you do not have consent to email.

## Options

### A. Free tiers (₹0), with trade-offs

| Piece        | Candidate                        | Caveat                                                                                             |
| ------------ | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| Web + worker | Render free web service (Docker) | Spins down after about 15 minutes idle and takes about a minute to wake. No free background worker |
| MySQL        | TiDB Cloud Starter               | MySQL-compatible, not MySQL; see the spike below. Free tier terms change                           |
| Scheduling   | `.github/workflows/tick.yml`     | Wakes the sleeping service once an hour and asks it to send what is due                            |
| Email        | Resend free plan                 | 100 emails per day, 3,000 per month                                                                |

Because the queue lives in the database and the tick endpoint drives the worker on demand, a sleeping service does not lose scheduled email; it sends the next time it is woken (at most about an hour late while nobody is using the app; within seconds while someone is). The tick is hourly, not more often, because Render's 750 free instance hours a month are shared by every free service in the workspace, and a service pinged every few minutes never sleeps (about 744 hours), which would get all of them suspended. Resend's retry behaviour for webhooks delivered to a sleeping service was not verified; the reconciliation logic handles late events, but an event that Resend gives up on would be lost.

Steps:

1. Create the TiDB database and run the **compatibility check** below before relying on it.
2. Create a Render web service from the repository using `render.yaml` (Docker runtime, free plan). Set `APP_URL` (the `onrender.com` address, or your domain), `DATABASE_URL` (with `?ssl=true`), `SYSTEM_EMAIL_FROM`, `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`. `APP_SECRET` and `TICK_TOKEN` are generated by the blueprint, and it already selects `QUEUE_CLAIM_MODE=conditional-update`.
3. In GitHub, add repository secrets `APP_URL` and `TICK_TOKEN` (the same value as on the server).
4. Run the smoke test (below).

**Compatibility check for a hosted MySQL.** Use [TIDB_COMPATIBILITY.md](TIDB_COMPATIBILITY.md): `npm run db:compat`, `prisma migrate deploy` and the integration suite with `TEST_CLAIM_MODE=conditional-update`, against a dedicated empty database. If foreign keys, READ COMMITTED or the concurrent-claim check fails, that host does not support the design and a real MySQL is needed.

### B. Reliable and inexpensive

Always-on compute plus a managed MySQL, roughly $5–15 per month at the prices seen in research (secondary sources; check current pricing): for example Railway, or a small Render or Fly instance with Aiven's Developer MySQL tier. No tick workflow is needed because the in-process worker keeps running. Needs a spending decision, so it was not done.

### C. One small server

```bash
cp .env.production.example .env.production      # fill in every value
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Put a TLS-terminating reverse proxy (Caddy or nginx) in front of `127.0.0.1:3000` and set `APP_URL` to the https address.

## Migrations

The container runs `prisma migrate deploy` before starting, which is safe for a single instance. With more than one instance, run it once as a release step instead (`npx prisma migrate deploy`) and start the instances with `node dist/server.js`.

Prisma has no down migrations. To undo a change, restore a backup or write a new forward migration. Back up before every schema change:

```bash
mysqldump --single-transaction -h HOST -u USER -p DATABASE > backup.sql
```

## HTTPS and security configuration

TLS is terminated by the host or proxy. The app needs `TRUST_PROXY` set to the number of proxies behind it (`1`), and an `https` `APP_URL`, which switches on `Secure` cookies with the `__Host-` prefix and HSTS. The security headers, content security policy and rate limits are built in. See [SECURITY.md](SECURITY.md) for gaps, notably in-memory rate limits and no email verification.

## Logging and monitoring

Logs are JSON on stdout (pino) with a request id; the platform collects them. `GET /healthz` is for liveness checks and `GET /readyz` includes the database. The worker logs each run that did work with outcome counts. There is no metrics endpoint or alerting; a failed message is visible in the campaign's message list and in the analytics "could not be sent" count.

## Production smoke test

```bash
npm run smoke -- https://your-app.example.org
```

Checks health, readiness, headers, assets, the signed-out session probe, anonymous access refusal, an unsigned webhook and an invalid unsubscribe link. Add `--flow` to also register a throwaway account and create a contact (it creates data, so use it only when that is acceptable).

After the smoke test, by hand:

1. Register, set the sender identity, import `delivered+1@resend.dev`, `bounced+1@resend.dev` and `complained+1@resend.dev` with a consent basis, and launch a campaign to them.
2. Within a few minutes the campaign page should show Delivered, Bounced and Spam report. If statuses stay at "Accepted", the webhook is not reaching the app or the signing secret is wrong; check the Resend webhook log and `RESEND_WEBHOOK_SECRET`.
3. The bounced and complained addresses should appear on the suppression list.
4. Open an unsubscribe link from a delivered message.

Do not describe the application as deployed until these have been done against the live URL.
