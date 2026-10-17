import { expect, open, PASSWORD, sessionCookie, test } from './fixtures';

test('an admin adds a member, changes their role and removes them from the settings page', async ({
  adminPage: page,
  admin,
  seeded,
}) => {
  const email = `member-${seeded.slug}@e2e.test`;
  await admin.call('POST', '/users', { email, password: PASSWORD, role: 'viewer' });
  await open(page, `/ui/p/${seeded.slug}/settings`);
  const members = page.locator('section[aria-labelledby="members-title"]');
  await members.getByLabel('Email').fill(email);
  await members.getByLabel('Role', { exact: true }).selectOption('reviewer');
  await members.getByRole('button', { name: 'Add member' }).click();
  await expect(page.locator('.toast').last()).toContainText('Member added.');
  const row = members.locator('tr', { hasText: email });
  await expect(row.getByLabel(`Role of ${email}`)).toHaveValue('reviewer');

  // With JavaScript a new role saves at once.
  await row.getByLabel(`Role of ${email}`).selectOption('maintainer');
  await expect(page.locator('.toast').last()).toContainText('Member updated.');
  await expect(members.locator('tr', { hasText: email }).getByLabel(`Role of ${email}`)).toHaveValue('maintainer');

  await members.locator('tr', { hasText: email }).getByRole('button', { name: 'Remove' }).click();
  await page.locator('dialog.confirm').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.toast').last()).toContainText('Member removed.');
  await expect(members).not.toContainText(email);
});

test('a user outside a project does not see it until added', async ({ browser, baseURL, admin, seeded }) => {
  const email = `outsider-${seeded.slug}@e2e.test`;
  await admin.call('POST', '/users', { email, password: PASSWORD, role: 'reviewer' });
  const context = await browser.newContext({ baseURL });
  await context.addCookies([
    { name: 'pt_session', value: await sessionCookie(baseURL as string, email), url: baseURL as string },
  ]);
  const page = await context.newPage();

  await open(page, '/ui');
  await expect(page.locator('main')).not.toContainText(seeded.name);
  const hidden = await page.goto(`/ui/p/${seeded.slug}`);
  expect(hidden?.status()).toBe(404);
  await expect(page.locator('h1')).toHaveText('Project not found');
  expect((await page.request.get(`/ui/builds/${seeded.buildId}`)).status()).toBe(404);
  expect((await page.request.get(`/ui/checks/${seeded.changed}`)).status()).toBe(404);

  await admin.call('POST', `/projects/${seeded.slug}/members`, { email, role: 'viewer' });
  await open(page, '/ui');
  await page.getByRole('link', { name: new RegExp(seeded.name) }).click();
  await expect(page.locator('h1')).toHaveText(seeded.name);
  await context.close();
});
