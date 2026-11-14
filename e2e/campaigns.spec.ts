import { expect, test } from '@playwright/test';
import { csvFile, register, setUpSender } from './support.js';

test('launching is blocked until the workspace can send, and the reasons are shown', async ({
  page,
}) => {
  await register(page);
  await page.goto('/campaigns');
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  await page.getByLabel('Campaign name').fill('Too early');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await page.getByRole('button', { name: 'Review' }).click();

  await expect(page.getByText('Before you can launch')).toBeVisible();
  await expect(page.getByText('Add a sender name in Settings')).toBeVisible();
  await expect(page.getByText('Choose a list to send to')).toBeVisible();
  await expect(page.getByText('Write at least one email')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Launch campaign' })).toBeDisabled();
});

test('a campaign can be paused, resumed and cancelled', async ({ page }) => {
  await register(page);
  await setUpSender(page);
  await page.goto('/contacts');
  await page.getByRole('button', { name: 'Import CSV' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog
    .locator('input[type=file]')
    .setInputFiles(csvFile(['delivered+p@resend.dev,Pat,Acme']));
  await dialog.getByLabel('How did everyone in this file consent?').selectOption('signed_up');
  await dialog.getByLabel(/These people agreed to receive email/).check();
  await dialog.getByLabel('Add to list').selectOption({ index: 0 });
  await dialog.getByRole('button', { name: 'Import contacts' }).click();
  await expect(dialog.getByText('1 contacts imported')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();

  await page.goto('/lists');
  await page.getByRole('button', { name: 'Create a list' }).click();
  await dialog.getByLabel('List name').fill('Everyone');
  await dialog.getByRole('button', { name: 'Create list' }).click();
  await page.goto('/contacts');
  await page.getByRole('button', { name: 'Actions for delivered+p@resend.dev' }).click();
  await page.getByRole('menuitem', { name: 'Add to list' }).click();
  await dialog.getByRole('button', { name: 'Add to list' }).click();

  await page.goto('/campaigns');
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  await page.getByLabel('Campaign name').fill('Pause test');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await page.getByRole('radio', { name: /Everyone/ }).check();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByLabel('Subject').fill('Hello');
  await page.getByLabel('Message').fill('Hi there');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByLabel('On a date').check();
  await page
    .getByLabel('Start date and time')
    .fill(new Date(Date.now() + 86_400_000 * 3).toISOString().slice(0, 16));
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByRole('button', { name: 'Launch campaign' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Launch campaign' }).click();

  await expect(page.getByText('Starts ', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText('Campaign paused.')).toBeVisible();
  await expect(page.locator('.page-header .badge', { hasText: 'Paused' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByText('Campaign resumed')).toBeVisible();
  await expect(page.locator('.page-header .badge', { hasText: 'Scheduled' })).toBeVisible();

  await page.getByRole('button', { name: 'Cancel campaign' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel campaign' }).click();
  await expect(page.locator('.page-header .badge', { hasText: 'Cancelled' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0);
});
