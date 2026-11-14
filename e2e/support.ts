import { randomBytes } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { generateToken, sha256Hex } from '../src/lib/crypto.js';
import { createDb } from '../src/lib/db.js';
import { createUnsubscribeToken } from '../src/modules/unsubscribe/unsubscribe.token.js';

export const APP_SECRET = 'e2e-secret-that-is-at-least-32-characters-long';
export const PASSWORD = 'an-e2e-test-password';

let counter = 0;
export function uniqueEmail(label = 'user'): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}-${randomBytes(3).toString('hex')}@example.org`;
}

export async function register(page: Page, options: { name?: string; email?: string } = {}) {
  const email = options.email ?? uniqueEmail();
  await page.goto('/register');
  await page.getByLabel('Your name').fill(options.name ?? 'Test Person');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel(/Team or company/).fill('Acme Outreach');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  return { email };
}

export async function setUpSender(page: Page) {
  await page.goto('/settings?tab=sender');
  await page.getByLabel('Sender name').fill('Priya at Acme');
  await page.getByLabel('Sender email').fill('priya@acme.example');
  await page.getByLabel('Postal address').fill('12 Harbour Road, Bristol BS1 4AA, United Kingdom');
  await page.getByLabel('Sending window opens').selectOption('00:00');
  await page.getByLabel('Sending window closes').selectOption('24:00');
  await page.getByLabel(/Send on weekdays only/).uncheck();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await expect(page.getByText('Your sender identity is complete')).toBeVisible();
}

export function csvFile(rows: string[]) {
  return {
    name: 'leads.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(['email,first_name,company', ...rows].join('\n')),
  };
}

export const unsubscribeTokenFor = (messageId: number) =>
  createUnsubscribeToken(APP_SECRET, messageId);

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'mysql://cadentra:cadentra@127.0.0.1:3307/cadentra_test';

/**
 * Stands in for opening the e-mailed link: the simulated provider sends nothing a browser test can
 * read, so this plants a token for the user exactly as the server would and returns the secret.
 * Only the SHA-256 hash is stored, as in production.
 */
export async function plantAuthToken(
  email: string,
  purpose: 'password_reset' | 'email_verification',
  expiresInMs = 60 * 60 * 1000,
): Promise<string> {
  const db = createDb(DATABASE_URL);
  try {
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const token = generateToken();
    await db.authToken.create({
      data: {
        userId: user.id,
        purpose,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + expiresInMs),
      },
    });
    return token;
  } finally {
    await db.$disconnect();
  }
}
