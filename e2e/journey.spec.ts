import { expect, test } from '@playwright/test';
import { csvFile, register, setUpSender, unsubscribeTokenFor } from './support.js';

test('a team goes from sign-up to a delivered campaign, an unsubscribe and analytics', async ({
  page,
}) => {
  await register(page);

  // A new workspace is told what to do first.
  await expect(page.getByRole('heading', { name: 'Get ready to send' })).toBeVisible();
  await setUpSender(page);

  // Create a list, then import contacts into it with a recorded consent basis.
  await page.goto('/lists');
  await page.getByRole('button', { name: 'New list' }).click();
  await page.getByLabel('List name').fill('Expo leads');
  await page.getByRole('button', { name: 'Create list' }).click();
  await expect(page.getByRole('link', { name: 'Expo leads' })).toBeVisible();

  await page.goto('/contacts');
  await expect(page.getByRole('heading', { name: 'No contacts yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Import CSV' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog
    .locator('input[type=file]')
    .setInputFiles(
      csvFile([
        'delivered+a@resend.dev,Dana,Acme',
        'delivered+b@resend.dev,Eli,Acme',
        'bounced+a@resend.dev,Bo,Acme',
        'complained+a@resend.dev,Cy,Acme',
        'not-an-email,Bad,Row',
        'delivered+a@resend.dev,Dupe,Acme',
      ]),
    );
  await dialog.getByRole('button', { name: 'Import contacts' }).click();
  await expect(
    dialog
      .getByText('How did everyone in this file consent?')
      .locator('..')
      .getByText('Choose how these contacts consented.'),
  ).toBeVisible();
  await dialog.getByLabel('How did everyone in this file consent?').selectOption('event_attendee');
  await dialog.getByLabel('Add to list').selectOption({ label: 'Expo leads' });
  await dialog.getByRole('button', { name: 'Import contacts' }).click();
  await expect(
    dialog.getByText('Confirm that these contacts agreed to hear from you.'),
  ).toBeVisible();
  await dialog.getByLabel(/These people agreed to receive email/).check();
  await dialog.getByRole('button', { name: 'Import contacts' }).click();

  await expect(dialog.getByText('4 contacts imported')).toBeVisible();
  await expect(dialog.getByText('2 rows need attention')).toBeVisible();
  await expect(dialog.getByRole('cell', { name: 'Appears earlier in the file' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('delivered+a@resend.dev').first()).toBeVisible();
  await expect(page.getByText('Event attendee').first()).toBeVisible();

  // Build a two-email sequence.
  await page.goto('/campaigns');
  await expect(page.getByRole('heading', { name: 'No campaigns yet' })).toBeVisible();
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  await page.getByLabel('Campaign name').fill('Expo follow-up');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Expo follow-up' })).toBeVisible();

  await page.getByRole('radio', { name: /Expo leads/ }).check();
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await page.getByLabel('Subject').first().fill('Good to meet you, {{first_name|there}}');
  await page
    .getByLabel('Message')
    .first()
    .fill('Hi {{first_name|there}},\n\nThanks for stopping by our stand.');
  await page.getByRole('button', { name: 'Add a follow-up' }).click();
  await page.getByLabel('Subject').nth(1).fill('Following up');
  await page.getByLabel('Message').nth(1).fill('Just checking in.');
  await page.getByLabel('Days to wait before email 2').fill('1');
  await page.getByRole('button', { name: 'Preview' }).first().click();
  await expect(page.getByRole('dialog').getByText('Good to meet you, Alex')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
  await page.getByRole('button', { name: 'Save and continue' }).click();

  // Schedule: defaults from the workspace.
  await expect(page.getByRole('heading', { name: 'Sending window' })).toBeVisible();
  await page.getByRole('button', { name: 'Save and continue' }).click();

  // Review and launch.
  await expect(page.getByText('Ready to launch')).toBeVisible();
  await expect(page.getByText('4 people will receive the first email.')).toBeVisible();
  await page.getByRole('button', { name: 'Launch campaign' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Launch campaign' }).click();
  await expect(page.getByText('Campaign launched')).toBeVisible();
  await expect(page).toHaveURL(/\/campaigns\/\d+$/);
  const campaignId = page.url().split('/').at(-1);

  // The worker sends and the simulated provider reports back; statuses update on the page.
  const messages = page.getByRole('table').last();
  await expect(messages.getByRole('row', { name: /bounced\+a@resend\.dev.*Bounced/ })).toBeVisible({
    timeout: 25_000,
  });
  await expect(
    messages.getByRole('row', { name: /complained\+a@resend\.dev.*Spam report/ }),
  ).toBeVisible({ timeout: 25_000 });
  await expect(
    messages.getByRole('row', { name: /delivered\+a@resend\.dev.*Delivered/ }).first(),
  ).toBeVisible({ timeout: 25_000 });

  // Bounces and spam reports suppress the address automatically.
  await page.goto('/suppressions');
  await expect(page.getByRole('row', { name: /bounced\+a@resend\.dev.*Bounced/ })).toBeVisible();
  await expect(
    page.getByRole('row', { name: /complained\+a@resend\.dev.*Marked as spam/ }),
  ).toBeVisible();

  // A recipient follows the unsubscribe link from their email.
  const response = await page.request.get(`/api/v1/campaigns/${campaignId}/messages?limit=50`);
  const rows = (
    (await response.json()) as { data: { id: number; toEmail: string; step: number }[] }
  ).data;
  const target = rows.find((row) => row.toEmail === 'delivered+a@resend.dev' && row.step === 1)!;
  const anonymous = await page
    .context()
    .browser()!
    .newContext({ baseURL: page.url().split('/campaigns')[0]! });
  const visitor = await anonymous.newPage();
  await visitor.goto(`/u/${unsubscribeTokenFor(target.id)}`);
  await expect(
    visitor.getByRole('heading', { name: 'Unsubscribe from these emails?' }),
  ).toBeVisible();
  await expect(visitor.getByText(/d•+@resend\.dev/)).toBeVisible();
  await visitor.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(visitor.getByText('You are unsubscribed')).toBeVisible();
  await anonymous.close();

  await page.goto('/suppressions');
  await expect(
    page.getByRole('row', { name: /delivered\+a@resend\.dev.*Unsubscribed/ }),
  ).toBeVisible();

  // Their follow-up email is skipped, not sent.
  await page.goto(`/campaigns/${campaignId}`);
  await page.getByLabel('Filter messages by status').selectOption('skipped');
  await expect(page.getByRole('row', { name: /delivered\+a@resend\.dev.*Skipped/ })).toBeVisible();

  // Analytics reflect what really happened: 4 sent, 3 delivered (one later reported as spam), 1 bounced.
  await page.goto('/analytics');
  await expect(
    page.locator('.stat', { hasText: 'Sent' }).getByText('4', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.stat', { hasText: 'Delivered' }).getByText('75%')).toBeVisible();
  await expect(page.locator('.stat', { hasText: 'Bounced' }).getByText('25%')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Expo follow-up' })).toBeVisible();

  // The dashboard is built from the same rows.
  await page.goto('/');
  await expect(
    page.locator('.stat', { hasText: 'Active campaigns' }).getByText('1', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('launched a campaign to 4 people')).toBeVisible();
});
