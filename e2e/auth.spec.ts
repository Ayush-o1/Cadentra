import { expect, test } from '@playwright/test';
import { PASSWORD, register, uniqueEmail } from './support.js';

test('sign in, sign out and protected pages', async ({ page }) => {
  const email = uniqueEmail('auth');
  await page.goto('/contacts');
  await expect(page).toHaveURL(/\/login\?next=%2Fcontacts/);

  await page.goto('/register');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Enter your name')).toBeVisible();

  await register(page, { email });
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('definitely-the-wrong-one');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('alert').getByText('The email or password is incorrect'),
  ).toBeVisible();

  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.goto('/login');
  await expect(page).toHaveURL(/\/$/);
});

test('an expired session sends the user back to sign in', async ({ page }) => {
  await register(page);
  await page.context().clearCookies();
  await page.getByRole('link', { name: 'Contacts', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText('Your session has ended')).toBeVisible();
});

test('changing the password signs out other devices', async ({ page, browser }) => {
  const { email } = await register(page);
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto('/login');
  await otherPage.getByLabel('Email').fill(email);
  await otherPage.getByLabel('Password').fill(PASSWORD);
  await otherPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(otherPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page.goto('/settings?tab=security');
  await expect(page.getByText('This device')).toBeVisible();
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByLabel('New password').fill('a-brand-new-password');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Password changed')).toBeVisible();

  await otherPage.goto('/contacts');
  await expect(otherPage).toHaveURL(/\/login/);
  await other.close();
});
