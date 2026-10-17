import { join } from 'node:path';
import { expect, open, test } from './fixtures';

/** Ages every link of an email in the server's SQLite file, as if 8 days had passed. */
async function expire(email: string): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(process.env.E2E_DATA_DIR ?? '', 'pixeltwin.db'));
  db.prepare('update auth_links set expires_at = 1 where email = ?').run(email);
  db.close();
}

test('an invite link opened in a fresh browser creates the account and lands in the project', async ({
  adminPage: page,
  browser,
  baseURL,
  seeded,
}) => {
  const email = `invited-${seeded.slug}@e2e.test`;
  await open(page, `/ui/p/${seeded.slug}/settings`);
  const members = page.locator('section[aria-labelledby="members-title"]');
  await members.getByLabel('Email').fill(email);
  // Nobody has this email: the search offers the invite, and Enter sends it.
  await expect(page.getByRole('option', { name: `Invite ${email}` })).toBeVisible();
  await members.getByLabel('Email').press('ArrowDown');
  await members.getByLabel('Email').press('Enter');
  const link = (await page.locator('#new-link-value').textContent()) ?? '';
  expect(link).toContain('/ui/invite/');
  await expect(members.locator('.pending-invites')).toContainText(email);

  const fresh = await browser.newContext({ baseURL });
  const guest = await fresh.newPage();
  await guest.goto(link);
  await expect(guest.locator('h1')).toHaveText('Join pixeltwin');
  await expect(guest.locator('.sub')).toContainText(email);
  await guest.getByLabel('Password', { exact: true }).fill('a brand new password');
  await guest.getByRole('button', { name: 'Create account' }).click();
  await expect(guest.locator('h1')).toHaveText(seeded.name);
  await expect(guest.locator('.toast').last()).toContainText('Welcome!');
  await guest.goto(link);
  await expect(guest.locator('h1')).toHaveText('This link was already used');
  await fresh.close();
});

test('a revoked or expired invite link shows why it does not work', async ({
  adminPage: page,
  browser,
  baseURL,
  seeded,
}) => {
  const links: string[] = [];
  for (const who of ['revoked', 'expired']) {
    await open(page, `/ui/p/${seeded.slug}/settings`);
    const members = page.locator('section[aria-labelledby="members-title"]');
    await members.getByLabel('Email').fill(`${who}-${seeded.slug}@e2e.test`);
    await members.getByRole('button', { name: 'Invite by email' }).click();
    links.push((await page.locator('#new-link-value').textContent()) ?? '');
  }
  const row = page.locator('.pending-invites tr', { hasText: `revoked-${seeded.slug}` });
  await row.getByRole('button', { name: 'Revoke' }).click();
  await page.locator('dialog.confirm').getByRole('button', { name: 'Revoke' }).click();
  await expect(page.locator('.toast').last()).toContainText('Invite revoked.');
  await expire(`expired-${seeded.slug}@e2e.test`);

  const guest = await (await browser.newContext({ baseURL })).newPage();
  await guest.goto(links[0] ?? '');
  await expect(guest.locator('h1')).toHaveText('This link does not work');
  await guest.goto(links[1] ?? '');
  await expect(guest.locator('h1')).toHaveText('This link has expired');
});
