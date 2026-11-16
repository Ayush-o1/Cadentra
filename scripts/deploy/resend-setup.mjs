#!/usr/bin/env node
/**
 * Configures Resend through its API so no dashboard clicking is needed:
 *   1. creates a SENDING-ONLY API key for the running app (least privilege), and
 *   2. creates the webhook for https://<service>.onrender.com/webhooks/resend and stores its
 *      signing secret.
 * It needs one FULL-ACCESS key (RESEND_ADMIN_KEY) to do that. Delete that key in the Resend
 * dashboard afterwards; the app only ever receives the sending-only one.
 *
 *   node scripts/deploy/resend-setup.mjs            # does it
 *   node scripts/deploy/resend-setup.mjs --dry-run  # shows what it would do, changes nothing
 *   node scripts/deploy/resend-setup.mjs --rotate   # replaces an existing key / webhook
 *
 * Nothing is sent to anyone: no email goes out. Secrets go only to ~/.cadentra/secrets.env.
 */
import { api, fail, loadSecrets, ok, info, randomHex, require, saveSecrets, step } from './lib.mjs';

const RESEND = 'https://api.resend.com';
const KEY_NAME = 'cadentra-runtime';
// Only what the app acts on. Opens and clicks are deliberately not subscribed: Cadentra does not
// track them.
const EVENTS = [
  'email.delivered',
  'email.bounced',
  'email.complained',
  'email.delivery_delayed',
  'email.failed',
  'email.suppressed',
];

const dryRun = process.argv.includes('--dry-run');
const rotate = process.argv.includes('--rotate');
let secrets = loadSecrets();

try {
  require(secrets, 'RESEND_ADMIN_KEY');
} catch (error) {
  fail(error.message);
  process.exit(1);
}

// The service name is chosen once and reused, so the webhook URL can be known before the service
// exists (Render's address is https://<name>.onrender.com).
if (!secrets.SERVICE_NAME) {
  secrets.SERVICE_NAME = `cadentra-${randomHex(3)}`;
  if (!dryRun) saveSecrets({ SERVICE_NAME: secrets.SERVICE_NAME });
}
const endpoint = `https://${secrets.SERVICE_NAME}.onrender.com/webhooks/resend`;
const admin = secrets.RESEND_ADMIN_KEY;

step('Checking the admin key');
const keys = await api(RESEND, admin, 'GET', '/api-keys');
if (keys.status === 401 || keys.status === 403) {
  fail(
    `Resend refused the key (${keys.status}). It must be a FULL-ACCESS key: ` +
      'https://resend.com/api-keys, Create API Key, permission "Full access".',
  );
  process.exit(1);
}
if (!keys.ok) {
  fail(`Unexpected response from Resend: ${keys.status}`);
  process.exit(1);
}
ok('full-access key accepted');

step('Sending-only key for the app');
const existingKey = (keys.json?.data ?? []).find((k) => k.name === KEY_NAME);
if (secrets.RESEND_API_KEY && existingKey && !rotate) {
  ok(`already stored and present in Resend ("${KEY_NAME}"); use --rotate to replace it`);
} else if (dryRun) {
  info(
    `would create a sending_access key named "${KEY_NAME}"${existingKey ? ' (replacing the old one)' : ''}`,
  );
} else {
  if (existingKey) {
    const deleted = await api(RESEND, admin, 'DELETE', `/api-keys/${existingKey.id}`);
    if (!deleted.ok) fail(`could not delete the old "${KEY_NAME}" key (${deleted.status})`);
  }
  const created = await api(RESEND, admin, 'POST', '/api-keys', {
    name: KEY_NAME,
    permission: 'sending_access',
  });
  if (!created.ok || typeof created.json?.token !== 'string') {
    fail(`could not create the sending key (${created.status})`);
    process.exit(1);
  }
  saveSecrets({ RESEND_API_KEY: created.json.token });
  ok('created and stored (sending access only)');
}

step(`Webhook for ${endpoint}`);
const hooks = await api(RESEND, admin, 'GET', '/webhooks');
if (!hooks.ok) {
  fail(`could not list webhooks (${hooks.status})`);
  process.exit(1);
}
const existingHook = (hooks.json?.data ?? []).find((h) => h.endpoint === endpoint);
if (existingHook && secrets.RESEND_WEBHOOK_SECRET && !rotate) {
  ok('already exists and its signing secret is stored; use --rotate to replace it');
} else if (dryRun) {
  info(
    `would create a webhook for ${EVENTS.length} events${existingHook ? ' (replacing the old one)' : ''}`,
  );
} else {
  // A webhook's signing secret is only returned when it is created, so replacing is the only way to
  // obtain one for a webhook whose secret we do not hold. Only OUR endpoint is ever replaced.
  if (existingHook) {
    const deleted = await api(RESEND, admin, 'DELETE', `/webhooks/${existingHook.id}`);
    if (!deleted.ok) fail(`could not delete the old webhook (${deleted.status})`);
  }
  const created = await api(RESEND, admin, 'POST', '/webhooks', { endpoint, events: EVENTS });
  if (!created.ok || typeof created.json?.signing_secret !== 'string') {
    fail(
      `could not create the webhook (${created.status}). The Free plan allows ONE webhook endpoint: ` +
        'delete any other endpoint at https://resend.com/webhooks and run this again.',
    );
    process.exit(1);
  }
  saveSecrets({ RESEND_WEBHOOK_SECRET: created.json.signing_secret });
  ok(`created for ${EVENTS.join(', ')} and its signing secret stored`);
}

console.log(
  dryRun
    ? '\nDry run: nothing was changed.'
    : '\nResend is configured. Remember to delete the full-access key in the Resend dashboard when everything works.',
);
