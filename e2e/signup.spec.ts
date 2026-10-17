import type { Browser } from '@playwright/test';
import { expect, open, PASSWORD, test } from './fixtures';

/** Asks for access in a fresh browser and logs in there; returns that page. */
async function requestAccess(browser: Browser, baseURL: string, email: string, note: string) {
  const page = await (await browser.newContext({ baseURL })).newPage();
  await page.goto('/ui/login');
  await page.getByRole('link', { name: 'Request access' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Note (optional)').fill(note);
  await page.getByRole('button', { name: 'Request access' }).click();
  await expect(page.locator('h1')).toHaveText('Request received');
  await page.goto('/ui/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  return page;
}

test.describe
  .serial('sign-up with approval', () => {
    test.beforeAll(async ({ admin }) => {
      await admin.call('PUT', '/settings/signup', { mode: 'approval', domains: [] });
    });
    test.afterAll(async ({ admin }) => {
      await admin.call('PUT', '/settings/signup', { mode: 'off', domains: [] });
    });

    test('a person asks for access, waits, and an admin approves them into a project', async ({
      adminPage,
      browser,
      baseURL,
      seeded,
    }) => {
      const email = `carol-${seeded.slug}@e2e.test`;
      const guest = await requestAccess(browser, baseURL as string, email, `Need ${seeded.name}`);
      await expect(guest.locator('h1')).toHaveText('Waiting for an admin to approve your access');

      await open(adminPage, '/ui/admin/users');
      const request = adminPage.locator('.request', { hasText: email });
      await expect(request).toContainText(`Need ${seeded.name}`);
      await expect(request).toContainText('email not verified');
      await request.locator('summary', { hasText: 'Approve' }).click();
      await request.getByRole('checkbox', { name: seeded.name }).check();
      await request.getByLabel(`Role in ${seeded.name}`).selectOption('reviewer');
      await request.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(adminPage.locator('.toast').last()).toContainText('Access approved.');

      await guest.goto('/ui');
      await expect(guest.locator('main')).toContainText(seeded.name);
      await guest.getByRole('link', { name: new RegExp(seeded.name) }).click();
      await expect(guest.locator('h1')).toHaveText(seeded.name);
    });

    test('a turned-down person sees the reason and nothing else', async ({ adminPage, browser, baseURL, seeded }) => {
      const email = `dan-${seeded.slug}@e2e.test`;
      const guest = await requestAccess(browser, baseURL as string, email, 'Let me in');
      await open(adminPage, '/ui/admin/users');
      const request = adminPage.locator('.request', { hasText: email });
      await request.locator('summary', { hasText: 'Turn down' }).click();
      await request.getByLabel('Reason (optional, they see it)').fill('Not on the team');
      await request.getByRole('button', { name: 'Turn down', exact: true }).click();
      await expect(adminPage.locator('.toast').last()).toContainText('Request turned down.');
      await guest.goto(`/ui/p/${seeded.slug}`);
      await expect(guest.locator('h1')).toHaveText('Your request was turned down');
      await expect(guest.locator('main')).toContainText('Reason: Not on the team');
      await expect(guest.locator('main')).not.toContainText(seeded.name);
    });
  });
