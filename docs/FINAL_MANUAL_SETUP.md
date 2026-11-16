# Final manual setup

Hosting costs **₹0**: Render free web service, TiDB free database, Resend free plan, GitHub Actions (free for a public repository). Nothing here asks for a card. If any page asks for one, stop: that is a paid step you did not agree to.

Almost everything is already scripted (see [DEPLOYMENT_AUTOMATION_AUDIT.md](DEPLOYMENT_AUTOMATION_AUDIT.md) for what is verified and what is not). **Only three things need you.** About 15 minutes of your time, plus waiting for a build.

Secrets rule: never paste a key into chat, a commit or a file in this repository. The only place you type a secret is the hidden prompt in step 2, which writes it to `~/.cadentra/secrets.env` (readable only by you, outside the repository).

---

## 0. Do first (2 minutes): rotate the Render CLI key

An earlier command of mine accidentally printed your Render CLI's stored API key into the chat session. Treat it as exposed.

1. Open <https://dashboard.render.com/u/settings> and find **API Keys**.
2. Revoke every key you do not recognise (the CLI's key is named like a CLI login).
3. In your terminal run `render login`, press Enter, and approve the browser prompt.

Success: `render whoami` prints your email.

## 1. Decision: approve the TiDB database (30 seconds)

A free TiDB database already exists. It was created with TiDB Cloud's account-free "Zero" API (no sign-up, no card) and expires on **2026-12-16** unless you claim it in step 4. I connected to it once and found a real bug (the connect timeout), but I was blocked from running the compatibility suite on it because you had not approved that service by name.

**Reply to me in the chat with: `Approved: use the TiDB Zero database.`** I will then run, with no further action from you:

1. the compatibility check and the integration suite against it,
2. the migrations on a fresh database for the live app.

_If you prefer your own TiDB account instead of Zero:_ sign up at <https://tidbcloud.com> (free, leave **Spending limit = 0**), create a **Starter** cluster, create a database named `cadentra` in **SQL Editor**, copy the connection details from **Connect → Public endpoint**, and enter the resulting URL (`mysql://USER:PASSWORD@HOST:4000/cadentra?ssl=true`) at the prompt in step 2. Then tell me and I continue.

## 2. Create your Resend account and one key (5 minutes)

1. Sign up at <https://resend.com/signup> (free). Confirm your email.
2. Open <https://resend.com/api-keys> → **Create API Key**.
   - **Name:** `cadentra-setup`
   - **Permission:** **Full access** (the setup script needs it to create the webhook and a sending-only key for the app)
   - **Domain:** leave as is. Click **Add**.
3. **Copy the key now** (it starts with `re_`; it is shown once). Secret: yes.
4. In VS Code's terminal, in the repository folder, run:

   ```bash
   bash scripts/deploy/store-secrets.sh
   ```

   - First prompt (**DATABASE_URL**): just press **Enter** (I fill this in after step 1).
   - Second prompt (**Resend FULL-ACCESS API key**): paste the `re_...` key and press Enter. Nothing is shown while you type; that is normal.

   Success: the script prints `saved RESEND_ADMIN_KEY` and `Nothing was printed or transmitted.`

5. Tell me in the chat: **`Secrets stored. Continue.`**

If it fails: re-run the command; it only changes what you type.

## What I do after steps 1 to 2 (nothing for you to click)

In this order, stopping and telling you if anything fails:

1. `node scripts/deploy/resend-setup.mjs`: creates a **sending-only** Resend key and the Resend webhook for the future Render address, and stores both secrets.
2. `node scripts/deploy/render-deploy.mjs create`: creates the free Render web service from the branch `chore/final-hardening` (**no merge to `main` needed**), waits for `/readyz`.
3. `node scripts/deploy/github-secrets.mjs`: sets `APP_URL` and `TICK_TOKEN` for the hourly wake workflow.
4. `node scripts/deploy/verify-live.mjs <the live URL>`: registers a throwaway account, sets the sender, imports three Resend **test** addresses, launches, and waits for delivered, bounced and spam-report events to arrive through the webhook, then checks automatic suppression and that the app sees your real IP.
5. Triggers the "Wake and tick" workflow once and reads its result.
6. Updates the README and deployment docs with what actually passed, and reports the live URL.

Only test addresses (`@resend.dev`) are ever emailed. The live check will not run otherwise.

## 3. After it works (5 minutes, within 30 days)

1. **Claim the TiDB database** so it does not expire. Get the claim link with:

   ```bash
   jq -r .instance.claimInfo.claimUrl ~/.cadentra/tidb-zero.json
   ```

   Open it, sign in or sign up at TiDB Cloud (free), accept the claim. Then open the cluster's **Settings** and check **Spending limit** is **0** (it must stay 0 so it cannot charge you). Success: the cluster appears in your TiDB Cloud dashboard as a **Starter** cluster.
   _If you skip this, the database is deleted on 2026-12-16 and the app stops working._

2. **Delete the Resend setup key.** <https://resend.com/api-keys> → the row `cadentra-setup` → **Delete**. The app only uses the sending-only key `cadentra-runtime`.

3. **Check Render's shared free hours after a week:** <https://dashboard.render.com/billing#included-usage>. All your free Render services share 750 hours a month. If the total is close to 750, disable the workflow: <https://github.com/Ayush-o1/Cadentra/actions/workflows/tick.yml> → **⋯ → Disable workflow**.

4. **Optional, when you want it:** merge pull request #1 (<https://github.com/Ayush-o1/Cadentra/pull/1>) with **Merge pull request**. Render is deployed from the branch, so this changes nothing about the running app; after merging, point the service at `main` in Render → the service → **Settings → Build & Deploy → Branch**.

## If something fails

| Symptom                                              | What to do                                                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `store-secrets.sh` says command not found            | Run it from the repository folder: `cd ~/Desktop/Cadentra`                                                                              |
| `resend-setup` says Resend refused the key (401/403) | The key was not **Full access**. Create a new one at <https://resend.com/api-keys> and run `bash scripts/deploy/store-secrets.sh` again |
| `resend-setup` cannot create the webhook             | The free plan allows **one** webhook. Delete any other endpoint at <https://resend.com/webhooks>, then ask me to re-run it              |
| `render-deploy create` times out                     | Free instances build slowly. Ask me to run `node scripts/deploy/render-deploy.mjs logs`; I will read the error                          |
| Live check says events stay `accepted`               | The webhook is not reaching the app or the signing secret is wrong. Ask me to run `resend-setup.mjs --rotate`                           |
| App sleeps and the first page load is slow           | Normal on the free plan: about a minute to wake. The hourly workflow wakes it                                                           |
| TiDB connections are refused late in a month         | The free request-unit allowance is used up. See usage in TiDB Cloud; ask me to raise `WORKER_POLL_MS`                                   |

## What is not included, on purpose

- A custom domain or a verified sending domain (they cost money). Without one, Resend can only email your own address and its test addresses, which is all this setup needs.
- Merging to `main`: only with your say-so.
