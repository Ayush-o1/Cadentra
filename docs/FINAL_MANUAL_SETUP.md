# Final manual setup

**Cadentra is live: https://cadentra-3be838.onrender.com** (first load after idle takes about a minute, because the free plan sleeps). It is connected to its database, processes its email queue, and receives real Resend events. What was verified is listed in [DEPLOYMENT_AUTOMATION_AUDIT.md](DEPLOYMENT_AUTOMATION_AUDIT.md).

Hosting costs **₹0**. Nothing below asks for a card. If a page asks for one, stop.

Four things remain, and only you can do them. About 10 minutes.

---

## 1. Claim the TiDB database (3 minutes) — do this within 30 days

The database was created without an account, so **it is deleted on 2026-12-16 and the app stops working unless you claim it.**

1. In your terminal, in the repository folder, print the claim link (it is a private link; do not share it):

   ```bash
   jq -r .instance.claimInfo.claimUrl ~/.cadentra/tidb-zero.json
   ```

2. Open it in your browser. Sign in or sign up at TiDB Cloud (free, no card). Accept the claim.
3. Open the new cluster in <https://tidbcloud.com> → **Settings** (or **Billing**) and check the **Spending limit** is **0**. It must stay 0 so nothing can ever be charged.

Success: the cluster appears in your TiDB Cloud dashboard as a **Starter** cluster, and https://cadentra-3be838.onrender.com/readyz still answers `{"status":"ok","database":"up"}`.
If it fails: tell me the message you see. Do nothing else with the database.

## 2. Turn on the hourly wake-up (3 minutes, after you merge)

Scheduled GitHub workflows run from `main`. `main` still has the old version that wakes the service **every 5 minutes**, which would use up Render's free hours (shared across all your free services), so I **disabled** it. The hourly version is on the branch in pull request #1.

1. Open <https://github.com/Ayush-o1/Cadentra/pull/1>. Check the **Checks** show green.
2. Click **Merge pull request**, then **Confirm merge**.
3. Open <https://github.com/Ayush-o1/Cadentra/actions/workflows/tick.yml>. Click **Enable workflow**. (The secrets `APP_URL` and `TICK_TOKEN` are already set.)
4. Click **Run workflow** → **Run workflow** once, and wait for a green run.

Success: the run is green and its log shows `{"data":{"claimed":0,...}}`.
If you do **not** want to merge yet: skip this step. The app works; scheduled emails then send only while someone has the app open.

Optionally afterwards, in Render → the service **cadentra-3be838** → **Settings → Build & Deploy → Branch**, change `chore/final-hardening` to `main`.

## 3. Delete the Resend setup key (1 minute)

1. Open <https://resend.com/api-keys>.
2. On the row named **`cadentra-setup`**, click the **⋯** menu → **Delete** → confirm.

Keep **`cadentra-runtime`**: that is the sending-only key the running app uses.

## 4. Rotate the Render CLI key (2 minutes)

An earlier command of mine printed your Render CLI's stored key into the chat session. Treat it as exposed.

1. Open <https://dashboard.render.com/u/settings> → **API Keys**. Revoke any key you do not recognise.
2. In your terminal run `render login`, press Enter, and approve in the browser.

Success: `render whoami` prints your email.

---

## Good to know

- **Try it:** register on the live site with your own email. Without a verified sending domain, Resend can only deliver to your own address and to its `@resend.dev` test addresses, so keep test contacts to those. Confirmation and reset emails to other people will not arrive; the app copes with that and `REQUIRE_VERIFIED_EMAIL` is off for this reason.
- **Free limits:** Resend 100 emails a day and 3,000 a month. Render shares 750 free hours a month across **all** your free services (check <https://dashboard.render.com/billing#included-usage> after a week). TiDB refuses new connections if its monthly 50 million request units run out.
- **Redeploy after a code change:** `node scripts/deploy/render-deploy.mjs redeploy`. Logs: `node scripts/deploy/render-deploy.mjs logs`. Full live check (sends only to test addresses): `node scripts/deploy/verify-live.mjs https://cadentra-3be838.onrender.com`.
- **CHECK constraints** are not enforced by TiDB (the app enforces the same rules). Details in [TIDB_COMPATIBILITY.md](TIDB_COMPATIBILITY.md).
- Test accounts named `delivered+verify-…@resend.dev` remain in the live database from the verification runs; they do no harm.

## If something goes wrong

| Symptom                                   | What to do                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Site shows a loading page for a minute    | Normal on the free plan; it is waking up                                                                                      |
| `readyz` says database down               | The TiDB claim lapsed or its request units ran out: check TiDB Cloud first                                                    |
| Events stay "Accepted", never "Delivered" | Webhook not arriving. Run `node scripts/deploy/resend-setup.mjs --rotate` (needs the full-access key; create a new one first) |
| Free hours nearly used                    | Disable the workflow: <https://github.com/Ayush-o1/Cadentra/actions/workflows/tick.yml> → **⋯ → Disable workflow**            |
