import { expect, open, test } from './fixtures';

test('a new token is shown once in the dialog and copies to the clipboard', async ({ adminPage: page, seeded }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, `/ui/p/${seeded.slug}/settings`);
  await page.getByRole('link', { name: 'New token' }).click();
  const dialog = page.locator('dialog#new-token');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name').fill('GitHub Actions');
  await dialog.getByRole('button', { name: 'Create token' }).click();
  const token = (await dialog.locator('#new-token-value').textContent()) ?? '';
  expect(token).toMatch(/^pt_[0-9A-Za-z]{8}_[0-9A-Za-z]{32}$/);
  await dialog.getByRole('button', { name: 'Copy' }).click();
  await expect(page.locator('.toast').last()).toContainText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('table')).toContainText('GitHub Actions');
});

test('the theme switch applies at once and survives a reload', async ({ reviewerPage: page }) => {
  await open(page, '/ui');
  await page.locator('.menu summary').click();
  await page.getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('the build page lists screenshots newest first and narrows them as you type', async ({
  reviewerPage: page,
  seeded,
}) => {
  await open(page, `/ui/builds/${seeded.buildId}?filter=all`);
  const names = page.locator('.check-card:visible .check-name');
  await expect(names).toHaveText(['footer', 'cart', 'home']);
  await page.getByRole('searchbox', { name: /Search screenshots/ }).fill('CA');
  await expect(names).toHaveText(['cart']);
  await expect(page).toHaveURL(/q=CA/);
  await page.getByRole('searchbox', { name: /Search screenshots/ }).fill('nothing like this');
  await expect(page.getByText('No checks match this search.')).toBeVisible();
  await page.getByRole('searchbox', { name: /Search screenshots/ }).fill('');
  await expect(names).toHaveCount(3);
});

test('Ctrl+K opens the palette; Enter goes to the match', async ({ reviewerPage: page, seeded }) => {
  await open(page, '/ui');
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox');
  await expect(input).toBeFocused();
  await input.fill(seeded.name);
  await expect(page.getByRole('option').first()).toContainText(seeded.name);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/ui/p/${seeded.slug}$`));
});

test('a project waiting for its first build turns into the branch list when it arrives', async ({
  adminPage: page,
  admin,
}) => {
  const slug = `e2e-${Math.random().toString(36).slice(2, 10)}`;
  await admin.call('POST', '/projects', { slug, name: 'Fresh' });
  await open(page, `/ui/p/${slug}`);
  await expect(page.getByRole('heading', { name: 'Send your first screenshots' })).toBeVisible();
  const { token } = await admin.call<{ token: string }>('POST', `/projects/${slug}/tokens`, {
    name: 'ci',
    scopes: ['write'],
  });
  const build = await fetch(`${admin.url}/api/v1/projects/${slug}/builds`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(build.status).toBe(201);
  await expect(page.locator('.lane')).toBeVisible({ timeout: 15_000 });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the action bar stays in reach and a swipe moves to the next check', async ({ reviewerPage: page, seeded }) => {
    await open(page, `/ui/checks/${seeded.fresh}?filter=pending`);
    const approve = page.getByRole('button', { name: /Approve/ });
    await expect(approve).toBeInViewport();
    await page.locator('.review-head').evaluate((el) => {
      const touch = (x: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 100 });
      el.dispatchEvent(
        new TouchEvent('touchstart', { bubbles: true, touches: [touch(300)], changedTouches: [touch(300)] }),
      );
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [touch(150)] }));
    });
    await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.changed}`));
  });
});
