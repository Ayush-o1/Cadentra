import { expect, test } from '@playwright/test';
import { PASSWORD, plantAuthToken, register, uniqueEmail } from './support.js';

test('forgot password gives the same answer for any address', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();

  await page.getByLabel('Email').fill('nobody-here@example.org');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText('Check your inbox')).toBeVisible();
  await expect(page.getByText(/If an account exists for nobody-here@example.org/)).toBeVisible();
});

test('a reset link sets a new password, ends other sessions and works once', async ({
  page,
  browser,
}) => {
  const { email } = await register(page);

  // A second device that is signed in when the password changes.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto('/login');
  await otherPage.getByLabel('Email').fill(email);
  await otherPage.getByLabel('Password').fill(PASSWORD);
  await otherPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(otherPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  const token = await plantAuthToken(email, 'password_reset');
  await page.goto(`/reset-password#token=${token}`);
  // The secret leaves the address bar straight away.
  await expect(page).toHaveURL(/\/reset-password$/);

  await page.getByLabel('New password', { exact: true }).fill('a-new-e2e-password');
  await page.getByLabel('Repeat new password').fill('something-different');
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByText('The passwords do not match')).toBeVisible();

  await page.getByLabel('Repeat new password').fill('a-new-e2e-password');
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page).toHaveURL(/\/login\?reset=1/);
  await expect(page.getByText('Password updated')).toBeVisible();

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('a-new-e2e-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await otherPage.reload();
  await expect(otherPage).toHaveURL(/\/login/);
  await other.close();

  // The same link cannot be used again.
  await page.context().clearCookies();
  await page.goto(`/reset-password#token=${token}`);
  await page.getByLabel('New password', { exact: true }).fill('and-yet-another-one');
  await page.getByLabel('Repeat new password').fill('and-yet-another-one');
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(
    page.getByRole('alert').getByText(/invalid, has expired or was already used/),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();
});

test('a reset page without a token explains what to do', async ({ page }) => {
  await page.goto('/reset-password');
  await expect(page.getByRole('heading', { name: 'Reset link incomplete' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();
});

test('confirming the email address from the link, and what an expired link says', async ({
  page,
}) => {
  const { email } = await register(page, { email: uniqueEmail('verify') });
  await page.goto('/settings');
  await expect(page.getByText('Your email address is not confirmed yet')).toBeVisible();

  const token = await plantAuthToken(email, 'email_verification');
  await page.goto(`/verify-email#token=${token}`);
  await expect(page.getByText('Email confirmed')).toBeVisible();

  await page.getByRole('link', { name: 'Go to the dashboard' }).click();
  await page.goto('/settings');
  await expect(page.getByText('Your email address is not confirmed yet')).toHaveCount(0);

  const expired = await plantAuthToken(email, 'email_verification', -1000);
  await page.goto(`/verify-email#token=${expired}`);
  await expect(
    page.getByRole('alert').getByText(/invalid, has expired or was already used/),
  ).toBeVisible();
});

test('the unconfirmed-email notice can send a new link', async ({ page }) => {
  await register(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Send a new link' }).click();
  await expect(page.getByText('Confirmation email sent')).toBeVisible();
});
