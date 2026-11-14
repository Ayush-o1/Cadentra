import { expect, test } from '@playwright/test';
import { register } from './support.js';

test('every main page loads with a heading, landmarks and no console errors', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));

  await register(page);
  for (const [path, heading] of [
    ['/', 'Dashboard'],
    ['/contacts', 'Contacts'],
    ['/lists', 'Lists'],
    ['/suppressions', 'Suppression list'],
    ['/campaigns', 'Campaigns'],
    ['/analytics', 'Analytics'],
    ['/settings', 'Settings'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  }
  expect(problems).toEqual([]);
});

test('empty workspaces show helpful empty states, and unknown pages say so', async ({ page }) => {
  await register(page);
  await page.goto('/analytics');
  await expect(
    page.getByRole('heading', { name: 'Nothing was sent in this period' }),
  ).toBeVisible();
  await page.goto('/suppressions');
  await expect(page.getByRole('heading', { name: 'Nobody is suppressed' })).toBeVisible();
  await page.goto('/campaigns/999999');
  await expect(page.getByText(/not found/i)).toBeVisible();
  await page.goto('/this-page-does-not-exist');
  await expect(page.getByRole('heading', { name: 'This page does not exist' })).toBeVisible();
});

test('the unsubscribe page rejects an invalid link without leaking anything', async ({ page }) => {
  await page.goto('/u/1.not-a-real-signature');
  await expect(page.getByRole('heading', { name: 'This link is not valid' })).toBeVisible();
});

test('modals trap focus and close with Escape; menus work from the keyboard', async ({ page }) => {
  await register(page);
  await page.goto('/contacts');
  const trigger = page.getByRole('button', { name: 'Add contact' }).first();
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Email')).toBeFocused();
  for (let i = 0; i < 20; i++) await page.keyboard.press('Tab');
  expect(
    await page.evaluate(() =>
      document.querySelector('[role=dialog]')!.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.locator('.user-button').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('navigation opens as a drawer and the layout does not scroll sideways', async ({ page }) => {
    await register(page);
    await page.goto('/contacts');
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await page.getByRole('link', { name: 'Campaigns' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
