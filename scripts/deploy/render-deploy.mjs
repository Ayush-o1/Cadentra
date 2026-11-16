#!/usr/bin/env node
/**
 * Creates (or redeploys) the Cadentra web service on Render through the official Render CLI, which
 * must already be logged in (`render login`). FREE PLAN ONLY: the plan is fixed in this file and
 * the script refuses to continue if Render reports anything else.
 *
 *   node scripts/deploy/render-deploy.mjs plan                    # prints what it would do
 *   node scripts/deploy/render-deploy.mjs create [--branch NAME]  # creates the service and waits for /healthz
 *   node scripts/deploy/render-deploy.mjs redeploy                # deploys the latest commit of the branch
 *   node scripts/deploy/render-deploy.mjs logs                    # last 100 log lines
 *
 * Secrets come from ~/.cadentra/secrets.env and are passed to the Render CLI as arguments, which are
 * visible to other processes of YOUR user on this computer while it runs (acceptable on a personal
 * machine) and are never printed.
 */
import { spawnSync } from 'node:child_process';
import { fail, info, loadSecrets, ok, randomHex, require, saveSecrets, step } from './lib.mjs';

const [command = 'plan', ...flags] = process.argv.slice(2);
const branchIndex = flags.indexOf('--branch');
const branch = branchIndex >= 0 ? flags[branchIndex + 1] : 'chore/final-hardening';

const PLAN = 'free'; // never changed by an option: hosting must cost nothing
const REGION = 'oregon'; // same AWS region as TiDB Cloud's us-west-2 gateway, to keep query latency low
const REPO = 'https://github.com/Ayush-o1/Cadentra';

function render(args, { json = true } = {}) {
  const result = spawnSync('render', [...args, ...(json ? ['-o', 'json'] : []), '--confirm'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return result;
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const secrets = loadSecrets();

if (command === 'logs') {
  require(secrets, 'RENDER_SERVICE_ID');
  const out = render(['logs', '-r', secrets.RENDER_SERVICE_ID, '--limit', '100'], { json: false });
  console.log(out.stdout || out.stderr);
  process.exit(0);
}

if (command === 'redeploy') {
  require(secrets, 'RENDER_SERVICE_ID');
  step('Redeploying');
  const result = spawnSync(
    'render',
    ['deploys', 'create', secrets.RENDER_SERVICE_ID, '--wait', '--confirm', '-o', 'text'],
    {
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) {
    fail('the deploy failed. Run: node scripts/deploy/render-deploy.mjs logs');
    process.exit(1);
  }
  ok('deploy finished');
  process.exit(0);
}

if (command !== 'plan' && command !== 'create') {
  fail(`unknown command "${command}"`);
  process.exit(2);
}

try {
  require(secrets, 'DATABASE_URL', 'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'SERVICE_NAME');
} catch (error) {
  fail(error.message);
  process.exit(1);
}
const dryRun = command === 'plan';

if (!dryRun) {
  saveSecrets({
    APP_SECRET: secrets.APP_SECRET ?? randomHex(32),
    TICK_TOKEN: secrets.TICK_TOKEN ?? randomHex(24),
  });
}
const full = loadSecrets();
const systemFrom = full.SYSTEM_EMAIL_FROM ?? 'Cadentra <onboarding@resend.dev>';

const env = {
  NODE_ENV: 'production',
  TRUST_PROXY: '3', // measured live on Render: 1 and 2 leave the app seeing a proxy address
  EMAIL_PROVIDER: 'resend',
  RUN_WORKER: 'true',
  QUEUE_CLAIM_MODE: 'conditional-update',
  WORKER_POLL_MS: '10000',
  REQUIRE_VERIFIED_EMAIL: 'false',
  SYSTEM_EMAIL_FROM: systemFrom,
  DATABASE_URL: full.DATABASE_URL,
  APP_SECRET: full.APP_SECRET ?? '(generated at create)',
  TICK_TOKEN: full.TICK_TOKEN ?? '(generated at create)',
  RESEND_API_KEY: full.RESEND_API_KEY,
  RESEND_WEBHOOK_SECRET: full.RESEND_WEBHOOK_SECRET,
  // APP_URL is intentionally absent: the app uses Render's own RENDER_EXTERNAL_URL.
};
const redacted = new Set([
  'DATABASE_URL',
  'APP_SECRET',
  'TICK_TOKEN',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
]);

step('Who am I on Render?');
const who = render(['whoami']);
const me = parse(who.stdout);
if (who.status !== 0 || !me) {
  fail('The Render CLI is not logged in. Run: render login');
  process.exit(1);
}
ok(`logged in as ${me.email}`);

step('Existing services');
const list = render(['services']);
const services = (parse(list.stdout) ?? [])
  .map((entry) => entry.service ?? entry)
  .filter((s) => s?.name);
const existing = services.find((s) => s.name === full.SERVICE_NAME);
if (existing) {
  ok(`"${full.SERVICE_NAME}" already exists (${existing.id}); not creating a duplicate`);
  saveSecrets({ RENDER_SERVICE_ID: existing.id });
  info('To deploy new commits run: node scripts/deploy/render-deploy.mjs redeploy');
  process.exit(0);
}
info(`${services.length} other service(s) in this workspace are left untouched`);

const args = [
  'services',
  'create',
  '--name',
  full.SERVICE_NAME,
  '--type',
  'web_service',
  '--runtime',
  'docker',
  '--plan',
  PLAN,
  '--region',
  REGION,
  '--repo',
  REPO,
  '--branch',
  branch,
  '--health-check-path',
  '/healthz',
  '--auto-deploy=false',
  ...Object.entries(env).flatMap(([key, value]) => ['--env-var', `${key}=${value}`]),
];

step(`Create ${full.SERVICE_NAME} (plan ${PLAN}, region ${REGION}, branch ${branch})`);
if (dryRun) {
  for (const [key, value] of Object.entries(env)) {
    info(`env ${key}=${redacted.has(key) ? '<hidden>' : value}`);
  }
  console.log('\nPlan only: nothing was created. Run with "create" to proceed.');
  process.exit(0);
}

const created = render(args);
const service = parse(created.stdout);
const id = service?.service?.id ?? service?.id;
const url = service?.service?.serviceDetails?.url ?? service?.serviceDetails?.url;
const plan = service?.service?.serviceDetails?.plan ?? service?.serviceDetails?.plan;
if (created.status !== 0 || !id) {
  fail(
    `could not create the service: ${(created.stderr || created.stdout).trim().split('\n').slice(-3).join(' | ')}`,
  );
  process.exit(1);
}
if (plan && plan !== PLAN) {
  fail(
    `Render reports plan "${plan}", not "${PLAN}". Stop: check the dashboard and delete it if it is not free.`,
  );
  process.exit(1);
}
saveSecrets({ RENDER_SERVICE_ID: id, APP_URL: url ?? `https://${full.SERVICE_NAME}.onrender.com` });
ok(`created ${id} (${url ?? 'URL pending'})`);

const expected = `https://${full.SERVICE_NAME}.onrender.com`;
if (url && url !== expected) {
  fail(
    `Render gave ${url} instead of ${expected}, so the Resend webhook points at the wrong address. ` +
      'Set SERVICE_NAME in ~/.cadentra/secrets.env to the new subdomain and run resend-setup.mjs --rotate.',
  );
}

step('Waiting for the first deploy (free instances take several minutes to build)');
const target = url ?? expected;
const deadline = Date.now() + 20 * 60 * 1000;
let healthy = false;
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${target}/readyz`, { signal: AbortSignal.timeout(20_000) });
    if (response.ok) {
      healthy = true;
      break;
    }
  } catch {
    /* not up yet */
  }
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}
if (!healthy) {
  fail(
    'the service did not become ready in 20 minutes. Run: node scripts/deploy/render-deploy.mjs logs',
  );
  process.exit(1);
}
ok(`${target}/readyz is healthy (the database answered)`);
