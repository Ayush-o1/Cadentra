#!/usr/bin/env node
/**
 * Production smoke test. Checks that a running Cadentra instance is up, reaches its database,
 * serves the app with the expected security headers, and refuses unauthenticated API access.
 * It creates no data unless you pass --flow.
 *
 *   node scripts/smoke-test.mjs https://your-app.example.org
 *   node scripts/smoke-test.mjs http://localhost:3000 --flow   # also registers a throwaway account
 */
const [baseArg, ...flags] = process.argv.slice(2);
const base = (baseArg ?? process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const withFlow = flags.includes('--flow');
const isHttps = base.startsWith('https://');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}
const get = (path, init) => fetch(`${base}${path}`, { redirect: 'manual', ...init });

console.log(`Smoke test against ${base}\n`);

await check('GET /healthz answers ok', async () => {
  const res = await get('/healthz');
  expect(res.status === 200, `status ${res.status}`);
  expect((await res.json()).status === 'ok', 'unexpected body');
});

await check('GET /readyz reports the database is reachable', async () => {
  const res = await get('/readyz');
  expect(res.status === 200, `status ${res.status} (is DATABASE_URL correct and migrated?)`);
  expect((await res.json()).database === 'up', 'database not up');
});

await check('the app shell is served with a strict content security policy', async () => {
  const res = await get('/', { headers: { Accept: 'text/html' } });
  expect(res.status === 200, `status ${res.status}`);
  const csp = res.headers.get('content-security-policy') ?? '';
  expect(csp.includes("script-src 'self'") && !csp.includes('unsafe-inline'), `CSP was: ${csp}`);
  expect(res.headers.get('x-powered-by') === null, 'x-powered-by is exposed');
  expect(res.headers.get('x-content-type-options') === 'nosniff', 'missing nosniff');
  if (isHttps)
    expect(
      (res.headers.get('strict-transport-security') ?? '').includes('max-age'),
      'missing HSTS over https',
    );
});

await check('static assets load', async () => {
  for (const path of ['/js/main.js', '/css/tokens.css', '/fonts/Geist-Variable.woff2']) {
    const res = await get(path);
    expect(res.status === 200, `${path} -> ${res.status}`);
  }
});

await check('deep links fall back to the app shell', async () => {
  const res = await get('/campaigns/1', { headers: { Accept: 'text/html' } });
  expect(
    res.status === 200 && (await res.text()).includes('<div id="app">'),
    `status ${res.status}`,
  );
});

await check('signed-out session probe is a normal 200 and is not cacheable', async () => {
  const res = await get('/api/v1/auth/session');
  expect(res.status === 200, `status ${res.status}`);
  expect((await res.json()).data === null, 'expected null data');
  expect(res.headers.get('cache-control') === 'no-store', 'API responses must be no-store');
});

await check('protected API routes refuse anonymous requests', async () => {
  for (const path of ['/api/v1/contacts', '/api/v1/campaigns', '/api/v1/dashboard']) {
    const res = await get(path);
    expect(res.status === 401, `${path} -> ${res.status}`);
  }
});

await check('an unsigned webhook is rejected, never processed', async () => {
  const res = await get('/webhooks/resend', {
    method: 'POST',
    body: '{"type":"email.bounced","data":{}}',
  });
  expect([400, 404].includes(res.status), `status ${res.status}`);
});

await check('an invalid unsubscribe link is refused', async () => {
  const res = await get('/api/v1/public/unsubscribe/1.invalid');
  expect(res.status === 404, `status ${res.status}`);
});

if (withFlow) {
  await check(
    'register, create a contact and read it back (creates a throwaway account)',
    async () => {
      const email = `smoke-${Date.now()}@example.org`;
      const origin = new URL(base).origin;
      const json = { 'Content-Type': 'application/json', Origin: origin };
      const register = await get('/api/v1/auth/register', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ name: 'Smoke Test', email, password: 'smoke-test-password' }),
      });
      expect(register.status === 201, `register -> ${register.status}`);
      const cookie = (register.headers.getSetCookie?.() ?? [])
        .map((c) => c.split(';')[0])
        .join('; ');
      expect(cookie.includes('cadentra_sid'), 'no session cookie');
      const headers = { ...json, Cookie: cookie };
      const created = await get('/api/v1/contacts', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: 'smoke-contact@example.org', consentBasis: 'signed_up' }),
      });
      expect(created.status === 201, `create contact -> ${created.status}`);
      const list = await (await get('/api/v1/contacts', { headers })).json();
      expect(list.data.length === 1, 'contact not listed');
    },
  );
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
