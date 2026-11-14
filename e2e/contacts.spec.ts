import { expect, test } from '@playwright/test';
import { register } from './support.js';

test('contacts: validation, duplicates, search, filters, editing and deleting', async ({
  page,
}) => {
  await register(page);
  await page.goto('/contacts');

  await page.getByRole('button', { name: 'Add contact' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email').fill('not-an-email');
  await dialog.getByRole('button', { name: 'Add contact' }).click();
  await expect(dialog.getByText('Enter a valid email address')).toBeVisible();

  await dialog.getByLabel('Email').fill('ada@analytical.example');
  await dialog.getByLabel('First name').fill('Ada');
  await dialog.getByLabel('Last name').fill('Lovelace');
  await dialog.getByLabel('Company').fill('Analytical Engines');
  await dialog.getByLabel('How did they consent?').selectOption('signed_up');
  await dialog.getByLabel('Where, exactly?').fill('Newsletter form');
  await dialog.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.getByText('Contact added')).toBeVisible();
  await expect(page.getByRole('row', { name: /Ada Lovelace.*Signed up/ })).toBeVisible();

  await page.getByRole('button', { name: 'Add contact' }).first().click();
  await dialog.getByLabel('Email').fill('ada@analytical.example');
  await dialog.getByRole('button', { name: 'Add contact' }).click();
  await expect(dialog.getByText('A contact with this email already exists')).toBeVisible();
  await page.keyboard.press('Escape');

  for (const [email, first] of [
    ['alan@bletchley.example', 'Alan'],
    ['grace@navy.example', 'Grace'],
  ]) {
    await page.getByRole('button', { name: 'Add contact' }).first().click();
    await dialog.getByLabel('Email').fill(email!);
    await dialog.getByLabel('First name').fill(first!);
    await dialog.getByRole('button', { name: 'Add contact' }).click();
    await expect(page.getByText('Contact added').last()).toBeVisible();
  }

  const search = page.getByLabel('Search contacts');
  await search.fill('grace');
  await expect(page.getByRole('row', { name: /grace@navy\.example/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /ada@analytical\.example/ })).toHaveCount(0);
  await search.fill('zzz');
  await expect(
    page.getByRole('heading', { name: 'No contacts match these filters' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByRole('row', { name: /ada@analytical\.example/ })).toBeVisible();

  // Edit
  await page.getByRole('button', { name: 'Actions for ada@analytical.example' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await dialog.getByLabel('Company').fill('Difference Engines');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('cell', { name: 'Difference Engines' })).toBeVisible();

  // Suppress then filter
  await page.goto('/suppressions');
  await page.getByRole('button', { name: 'Block an address' }).click();
  await dialog.getByLabel('Email address').fill('alan@bletchley.example');
  await dialog.getByRole('button', { name: 'Block address' }).click();
  await expect(
    page.getByRole('row', { name: /alan@bletchley\.example.*Blocked by you/ }),
  ).toBeVisible();
  await page.goto('/contacts?status=suppressed');
  await expect(
    page.getByRole('row', { name: /alan@bletchley\.example.*Blocked by you/ }),
  ).toBeVisible();
  await expect(page.getByRole('row', { name: /ada@analytical\.example/ })).toHaveCount(0);

  // Delete keeps the opt-out
  await page.getByRole('button', { name: 'Actions for alan@bletchley.example' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await dialog.getByRole('button', { name: 'Delete contact' }).click();
  await expect(page.getByText('Contact deleted')).toBeVisible();
  await page.goto('/suppressions');
  await expect(page.getByRole('row', { name: /alan@bletchley\.example/ })).toBeVisible();
});

test('lists: create, rename, add contacts and delete', async ({ page }) => {
  await register(page);
  await page.goto('/contacts');
  await page.getByRole('button', { name: 'Add contact' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email').fill('one@example.org');
  await dialog.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.getByText('Contact added')).toBeVisible();

  await page.goto('/lists');
  await expect(page.getByRole('heading', { name: 'No lists yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Create a list' }).click();
  await dialog.getByLabel('List name').fill('Newsletter');
  await dialog.getByRole('button', { name: 'Create list' }).click();
  await page.getByRole('button', { name: 'New list' }).click();
  await dialog.getByLabel('List name').fill('newsletter');
  await dialog.getByRole('button', { name: 'Create list' }).click();
  await expect(dialog.getByText('A list with this name already exists')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto('/contacts');
  await page.getByRole('button', { name: 'Actions for one@example.org' }).click();
  await page.getByRole('menuitem', { name: 'Add to list' }).click();
  await dialog.getByRole('button', { name: 'Add to list' }).click();
  await expect(page.getByText('Added to the list')).toBeVisible();

  await page.goto('/lists');
  await page.getByRole('link', { name: 'Newsletter' }).click();
  await expect(page.getByRole('row', { name: /one@example\.org/ })).toBeVisible();
  await page.goto('/lists');
  await page.getByRole('button', { name: 'Actions for Newsletter' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await dialog.getByRole('button', { name: 'Delete list' }).click();
  await expect(page.getByRole('heading', { name: 'No lists yet' })).toBeVisible();
});
