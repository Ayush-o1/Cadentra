import { expect, type Page } from '@playwright/test';
import { createUnsubscribeToken } from '../src/modules/unsubscribe/unsubscribe.token.js';

export const APP_SECRET = 'e2e-secret-that-is-at-least-32-characters-long';
export const PASSWORD = 'an-e2e-test-password';

let counter = 0;
export function uniqueEmail(label = 'user'): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}@example.org`;
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
