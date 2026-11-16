#!/usr/bin/env node
/**
 * End-to-end check of a RUNNING Cadentra instance (local or deployed): sign-up, sender setup, CSV
 * import, a one-step campaign to Resend's own TEST addresses, queue processing, provider
 * events arriving by webhook, automatic suppression, password-reset request, and (for https) that the
 * app sees your real IP, which proves TRUST_PROXY is right.
 *
 *   node scripts/deploy/verify-live.mjs https://your-app.onrender.com
 *   node scripts/deploy/verify-live.mjs http://localhost:3000 --tick-token <token>   # local
 *
 * SAFETY: every address this script emails ends in @resend.dev (Resend's test inbox, which delivers
 * to nobody). It refuses to run otherwise. It creates one throwaway account on the instance.
 * The tick token is read from ~/.cadentra/secrets.env (TICK_TOKEN) unless given with --tick-token.
 */
import { loadSecrets } from './lib.mjs';

const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? 'http://localhost:3000').replace(
  /\/+$/,
  '',
);
const tokenFlag = args.indexOf('--tick-token');
const tickToken = tokenFlag >= 0 ? args[tokenFlag + 1] : loadSecrets().TICK_TOKEN;
const isLocal = /localhost|127\.0\.0\.1/.test(base);

const run = Math.random().toString(16).slice(2, 8);
const account = {
  name: 'Verify Bot',
  email: `delivered+verify-${run}@resend.dev`,
  password: `verify-${run}-${Math.random().toString(36).slice(2)}`,
};
const recipients = {
  delivered: `delivered+live-${run}@resend.dev`,
  bounced: `bounced+live-${run}@resend.dev`,
  complained: `complained+live-${run}@resend.dev`,
};
for (const address of [account.email, ...Object.values(recipients)]) {
  if (!address.endsWith('@resend.dev')) throw new Error('Refusing: not a Resend test address');
}

let cookie = '';
let failures = 0;
const pass = (name) => console.log(`  ok    ${name}`);
const fail = (name, detail = '') => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, path, { body, csv, headers = {}, auth = true } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(csv
        ? { 'Content-Type': 'text/csv' }
        : body
          ? { 'Content-Type': 'application/json' }
          : {}),
      ...(auth && cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: csv ?? (body ? JSON.stringify(body) : undefined),
    redirect: 'manual',
    signal: AbortSignal.timeout(90_000), // a sleeping free instance needs about a minute to wake
  });
  const fresh = response.headers.getSetCookie?.() ?? [];
  if (fresh.length) cookie = fresh.map((c) => c.split(';')[0]).join('; ');
  const json = await response.json().catch(() => null);
  return { status: response.status, data: json?.data, error: json?.error, json };
}

async function expectOk(name, promise, wanted = [200, 201, 204]) {
  const result = await promise;
  if (wanted.includes(result.status)) {
    pass(name);
    return result;
  }
  fail(name, `HTTP ${result.status} ${result.error?.code ?? ''} ${result.error?.message ?? ''}`);
  throw new Error(`stopped at: ${name}`);
}

console.log(`Live verification of ${base}\nThrowaway account: ${account.email}\n`);

try {
  await expectOk('GET /healthz', call('GET', '/healthz', { auth: false }), [200]);
  await expectOk(
    'GET /readyz (database reachable)',
    call('GET', '/readyz', { auth: false }),
    [200],
  );

  const registered = await expectOk(
    'register',
    call('POST', '/api/v1/auth/register', {
      body: { ...account, workspaceName: 'Live verification' },
    }),
  );
  const unverified = registered.data?.user?.emailVerified === false;
  unverified ? pass('new account starts unconfirmed') : fail('new account starts unconfirmed');

  await expectOk(
    'sender identity',
    call('PATCH', '/api/v1/workspace', {
      body: {
        senderName: 'Cadentra Verify',
        senderEmail: 'onboarding@resend.dev',
        postalAddress: '1 Test Street, Testville, Testland',
        timezone: 'UTC',
        windowStartHour: 0,
        windowEndHour: 24,
        weekdaysOnly: false,
        dailySendLimit: 10,
      },
    }),
  );

  const list = (
    await expectOk(
      'create list',
      call('POST', '/api/v1/lists', { body: { name: `Verify ${run}` } }),
    )
  ).data;
  const csv = ['email,first_name', ...Object.entries(recipients).map(([k, v]) => `${v},${k}`)].join(
    '\n',
  );
  const imported = await expectOk(
    'import 3 Resend test addresses',
    call('POST', `/api/v1/contacts/import?consentBasis=other_documented&listId=${list.id}`, {
      csv,
    }),
  );
  if (imported.data?.created !== 3) fail('all three imported', JSON.stringify(imported.data));

  let campaign = (
    await expectOk(
      'create campaign',
      call('POST', '/api/v1/campaigns', { body: { name: 'Verify', listId: list.id } }),
    )
  ).data;
  campaign = (
    await expectOk(
      'write the email',
      call('PUT', `/api/v1/campaigns/${campaign.id}/steps`, {
        body: {
          version: campaign.version,
          steps: [
            {
              subject: 'Cadentra live check {{first_name|there}}',
              body: 'Hello {{first_name|there}},\n\nThis is an automated check.',
              delayDays: 0,
            },
          ],
        },
      }),
    )
  ).data;
  const current = (await call('GET', `/api/v1/campaigns/${campaign.id}`)).data;
  await expectOk(
    'launch',
    call('POST', `/api/v1/campaigns/${campaign.id}/launch`, { body: { version: current.version } }),
  );

  console.log('\n  waiting for the queue and the Resend webhooks (up to 6 minutes)...');
  const want = { delivered: 1, bounced: 1, complained: 1 };
  let counts = {};
  for (let i = 0; i < 36; i++) {
    if (tickToken)
      await call('POST', '/internal/tick', {
        headers: { Authorization: `Bearer ${tickToken}` },
        auth: false,
      });
    const messages =
      (await call('GET', `/api/v1/campaigns/${campaign.id}/messages?limit=50`)).data ?? [];
    counts = messages.reduce((acc, m) => ({ ...acc, [m.status]: (acc[m.status] ?? 0) + 1 }), {});
    if (Object.entries(want).every(([status, n]) => (counts[status] ?? 0) >= n)) break;
    await sleep(10_000);
  }
  const reached = Object.entries(want).every(([status, n]) => (counts[status] ?? 0) >= n);
  reached
    ? pass(`queue sent them and webhooks arrived: ${JSON.stringify(counts)}`)
    : fail(
        'queue and webhooks',
        `statuses after waiting: ${JSON.stringify(counts)}. "accepted" only means the webhook did not arrive or the signing secret is wrong.`,
      );

  const suppressions = (await call('GET', '/api/v1/suppressions')).data ?? [];
  const suppressed = new Set(suppressions.map((s) => s.email));
  suppressed.has(recipients.bounced.toLowerCase()) &&
  suppressed.has(recipients.complained.toLowerCase())
    ? pass('bounced and complained addresses were suppressed automatically')
    : fail('automatic suppression', `suppression list: ${[...suppressed].join(', ') || '(empty)'}`);

  const reset = await call('POST', '/api/v1/auth/forgot-password', {
    body: { email: account.email },
    auth: false,
  });
  reset.status === 202
    ? pass('password-reset request accepted (202)')
    : fail('password-reset request', `HTTP ${reset.status}`);

  if (!isLocal && base.startsWith('https://')) {
    const sessions = (await call('GET', '/api/v1/account/sessions')).data ?? [];
    const seen = sessions.find((s) => s.current)?.ipAddress;
    const mine = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(15_000) })
      .then((r) => r.text())
      .catch(() => '');
    if (!seen || !mine) fail('client IP check', 'could not determine either address');
    else if (seen.replace('::ffff:', '') === mine.trim())
      pass('the app sees your real IP (TRUST_PROXY is correct)');
    else
      fail(
        'client IP check',
        `the app saw ${seen} but your public IP is ${mine.trim()}: raise TRUST_PROXY by one`,
      );
  }
} catch (error) {
  if (!String(error.message).startsWith('stopped at'))
    fail('unexpected error', String(error.message));
}

console.log(failures === 0 ? '\nAll live checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
