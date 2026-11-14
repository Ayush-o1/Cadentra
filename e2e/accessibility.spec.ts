import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { register } from './support.js';

async function scan(page: Page) {
  // Entry animations would make axe measure colours mid-fade.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 3)
        .join(' | ')}`,
  );
}

test('signed-out pages have no WCAG A/AA violations', async ({ page }) => {
  for (const path of ['/login', '/register', '/u/1.not-valid']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await scan(page), path).toEqual([]);
  }
});

test('app pages have no WCAG A/AA violations', async ({ page }) => {
  await register(page);
  await page.goto('/contacts');
  await page.getByRole('button', { name: 'Add contact' }).first().click();
  await page.getByRole('dialog').waitFor();
  expect(await scan(page), 'contact modal').toEqual([]);
  await page.keyboard.press('Escape');

  for (const path of [
    '/',
    '/contacts',
    '/lists',
    '/suppressions',
    '/campaigns',
    '/analytics',
    '/settings?tab=sender',
    '/settings?tab=security',
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await scan(page), path).toEqual([]);
  }
});
