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

test('the eye button shows and hides a password', async ({ browser, baseURL }) => {
  const page = await (await browser.newContext({ baseURL })).newPage();
  await page.goto('/ui/login');
  const password = page.locator('input[name=password]');
  await password.fill('secret-words');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(password).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide password' }).click();
  await expect(password).toHaveAttribute('type', 'password');
  await expect(password).toHaveValue('secret-words');
});

test('the role hint follows the chosen role', async ({ adminPage: page }) => {
  await open(page, '/ui/admin/users/new');
  const hint = page.locator('#user-role-hint');
  await expect(hint).toContainText('cannot change anything');
  await page.locator('select[name=role]').selectOption('reviewer');
  await expect(hint).toContainText('Approves or rejects changes');
  await page.locator('select[name=role]').selectOption('admin');
  await expect(hint).toContainText('Manages everything');
});

test('a new build shows up on the project page without a reload', async ({ reviewerPage: page, seeded }) => {
  await open(page, `/ui/p/${seeded.slug}`);
  await page.evaluate(() => {
    (window as unknown as { stayed: boolean }).stayed = true;
  });
  await expect(page.locator('.lanes')).not.toContainText('feature/live');
  await seeded.ci.call('POST', `/projects/${seeded.slug}/builds`, { branch: 'feature/live' });
  // The page watches every 10 s when nothing runs; the new build is running, so it shows.
  await expect(page.locator('.lanes')).toContainText('feature/live', { timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);
});

test('Compare on the promote page zooms main, the branch and the diff together', async ({
  adminPage: page,
  seeded,
}) => {
  // The changed home screen, approved on a branch: main's baseline differs from it.
  const build = await seeded.ci.call<{ id: string }>('POST', `/projects/${seeded.slug}/builds`, {
    branch: 'feature/z',
  });
  const old = await seeded.ci.call<{ links: { image: string } }>('GET', `/checks/${seeded.changed}`);
  const image = await (await page.request.get(old.links.image)).body();
  const check = await seeded.ci.call<{ id: string }>('POST', `/builds/${build.id}/checks`, {
    name: 'home',
    variant: { browser: 'chromium' },
    imageBase64: image.toString('base64'),
  });
  await seeded.ci.call('POST', `/checks/${check.id}/approve`);

  await open(page, `/ui/p/${seeded.slug}/promote?branch=feature%2Fz`);
  await page.locator('summary', { hasText: 'Compare' }).first().click();
  const viewport = page.locator('.promote-viewport').first();
  const box = await viewport.boundingBox();
  if (!box) throw new Error('compare not open');
  const images = page.locator('.promote-large > figure:not(.promote-onion-pane) img');
  await expect(images).toHaveCount(3);
  const zoomed = async () => {
    for (const i of [0, 1, 2]) await expect(images.nth(i)).toHaveAttribute('style', /scale\((?!1\))/);
  };
  const fitted = async () => {
    for (const i of [0, 1, 2]) await expect(images.nth(i)).not.toHaveAttribute('style', /scale/);
  };
  const label = page.locator('[data-promote-zoom-label]').first();

  // A click zooms in where it lands, on all three images.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await zoomed();
  await expect(label).toHaveText(/%$/);
  await page.getByRole('button', { name: 'Fit' }).first().click();
  await fitted();
  await expect(label).toHaveText('Fit');
  // The wheel and the + button zoom too.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -600);
  await zoomed();
  await page.getByRole('button', { name: 'Fit' }).first().click();
  await page.getByRole('button', { name: 'Zoom in' }).first().click();
  await zoomed();
  await page.getByRole('button', { name: 'Fit' }).first().click();

  // Onion: the branch over main, faded with the range.
  await page.getByRole('button', { name: 'Onion' }).first().click();
  const onion = page.locator('.promote-onion').first();
  await expect(onion).toBeVisible();
  await expect(viewport).toBeHidden();
  const top = onion.locator('.promote-top-layer');
  await expect(top).toHaveAttribute('style', /opacity: 0\.5/);
  await page.locator('[data-promote-opacity]').first().fill('80');
  await expect(top).toHaveAttribute('style', /opacity: 0\.8/);
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

test('images show a skeleton while they load, and stop it once loaded', async ({ reviewerPage: page, seeded }) => {
  // Hold every screenshot until the test lets them through.
  let release: () => void = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route('**/api/v1/images/**', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`/ui/builds/${seeded.buildId}`);
  // On the build page the skeleton is the thumbnail's box under the image (build-page.spec.ts).
  const thumb = page.locator('.thumb-stack img').first();
  const box = page.locator('.thumb-stack .thumb-box').first();
  await expect(thumb).not.toHaveClass(/is-loaded/);
  expect(await box.evaluate((el) => getComputedStyle(el).animationName)).toBe('skeleton');
  release();
  await expect(thumb).toHaveClass(/is-loaded/);
  expect(await box.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});
