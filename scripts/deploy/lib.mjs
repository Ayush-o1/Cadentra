// Shared helpers for the deployment scripts. Secrets live in ~/.cadentra/secrets.env (mode 600),
// outside the repository, and are never printed.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const SECRETS_DIR = process.env.CADENTRA_SECRETS_DIR ?? path.join(homedir(), '.cadentra');
export const SECRETS_FILE = path.join(SECRETS_DIR, 'secrets.env');

export function loadSecrets() {
  if (!existsSync(SECRETS_FILE)) return {};
  const values = {};
  for (const line of readFileSync(SECRETS_FILE, 'utf8').split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

export function saveSecrets(updates) {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const merged = { ...loadSecrets(), ...updates };
  const text = Object.entries(merged)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  writeFileSync(SECRETS_FILE, `${text}\n`, { mode: 0o600 });
  chmodSync(SECRETS_FILE, 0o600);
}

/** Throws a message that names the missing settings (never their values). */
export function require(secrets, ...keys) {
  const missing = keys.filter((key) => !secrets[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(', ')} in ${SECRETS_FILE}. Run: bash scripts/deploy/store-secrets.sh`,
    );
  }
}

export const randomHex = (bytes) => randomBytes(bytes).toString('hex');

export function step(message) {
  console.log(`\n== ${message}`);
}
export const ok = (message) => console.log(`  ok    ${message}`);
export const info = (message) => console.log(`  ..    ${message}`);
export function fail(message) {
  console.error(`  FAIL  ${message}`);
  process.exitCode = 1;
}

/** Writes a JSON error body without ever echoing request headers or the API key. */
export async function api(base, key, method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      // Resend rejects requests without a User-Agent.
      'User-Agent': 'cadentra-deploy-scripts',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: response.status, json, ok: response.ok };
}
