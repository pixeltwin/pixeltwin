import { expect, open, REVIEWER, sessionCookie, test } from './fixtures';

interface CheckJson {
  review: string;
  reviewComment: string | null;
}

test('a reviewer goes through a build with the keyboard, without page loads', async ({
  reviewerPage: page,
  seeded,
}) => {
  await open(page, `/ui/checks/${seeded.changed}?filter=pending`);
  await page.evaluate(() => {
    (window as unknown as { stayed: boolean }).stayed = true;
  });
  await expect(page.locator('.review-position')).toHaveText('1 / 2');
  // The whole review fits the window: the filmstrip and the action bar are fully visible.
  await expect(page.locator('.frame').first()).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: /Approve/ })).toBeInViewport({ ratio: 1 });

  await page.keyboard.press('a');
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.fresh}`));
  await expect(page.locator('.toast').last()).toContainText('Approved home');

  // Undo goes back to the check and makes it pending again.
  await page.keyboard.press('u');
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.changed}`));
  expect((await seeded.ci.call<CheckJson>('GET', `/checks/${seeded.changed}`)).review).toBe('pending');

  await page.keyboard.press('a');
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.fresh}`));
  await page.keyboard.press('a');
  await expect(page.getByRole('heading', { name: 'Build reviewed' })).toBeVisible();
  await expect(page.locator('.reviewed-screen')).toContainText('2 approved · 0 rejected · 0 skipped');
  await expect(page.locator('.reviewed-screen')).toContainText('passed');

  expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);
  for (const id of [seeded.changed, seeded.fresh]) {
    expect((await seeded.ci.call<CheckJson>('GET', `/checks/${id}`)).review).toBe('approved');
  }
});

test('a small window still shows the filmstrip, with the stage shrinking instead', async ({
  reviewerPage: page,
  seeded,
}) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await open(page, `/ui/checks/${seeded.changed}?filter=pending`);
  await expect(page.locator('.frame').first()).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
});

test('a comment goes with the review: C to write, Esc to leave the field, R to reject', async ({
  reviewerPage: page,
  seeded,
}) => {
  await open(page, `/ui/checks/${seeded.changed}?filter=pending`);
  await page.keyboard.press('c');
  await page.keyboard.type('button colour is wrong');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.changed}`));
  await page.keyboard.press('r');
  await expect(page.locator('.toast').last()).toContainText('Rejected home');
  expect(await seeded.ci.call<CheckJson>('GET', `/checks/${seeded.changed}`)).toMatchObject({
    review: 'rejected',
    reviewComment: 'button colour is wrong',
  });
});

test('arrow keys move between checks; Shift+arrows move the slider', async ({ reviewerPage: page, seeded }) => {
  await open(page, `/ui/checks/${seeded.changed}?filter=pending`);
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.fresh}`));
  await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.changed}`));

  await page.keyboard.press('2');
  const divider = page.locator('.divider');
  await expect(divider).toHaveCSS('left', /px/);
  const before = await divider.evaluate((el) => (el as HTMLElement).style.left);
  await page.keyboard.press('Shift+ArrowRight');
  await expect(divider).not.toHaveAttribute('style', new RegExp(`left: ${before}`));
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.changed}`));
});

test('the slider follows the pointer and onion mode fades the new screenshot', async ({
  reviewerPage: page,
  seeded,
}) => {
  await open(page, `/ui/checks/${seeded.changed}`);
  await page.keyboard.press('2');
  const viewport = page.locator('.pane-overlay .viewport');
  const box = await viewport.boundingBox();
  if (!box) throw new Error('no overlay viewport');
  const divider = page.locator('.divider');
  const before = await divider.evaluate((el) => (el as HTMLElement).style.left);
  await page.mouse.move(box.x + box.width * 0.5, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + 100, { steps: 5 });
  await page.mouse.up();
  expect(await divider.evaluate((el) => (el as HTMLElement).style.left)).not.toBe(before);
  // Dragging never selects the images.
  expect(await page.evaluate(() => String(getSelection()))).toBe('');

  await page.keyboard.press('3');
  await expect(page.locator('.onion-control')).toBeVisible();
  await page.locator('[data-onion]').fill('20');
  await expect(page.locator('.layer-top')).toHaveCSS('opacity', '0.2');
});

test('a check someone else reviewed first is reported, and the review moves on', async ({
  reviewerPage: page,
  seeded,
  admin,
}) => {
  await open(page, `/ui/checks/${seeded.changed}?filter=pending`);
  await admin.call('POST', `/checks/${seeded.changed}/approve`);
  await page.keyboard.press('a');
  await expect(page.locator('.toast').last()).toContainText('Already approved by admin@e2e.test');
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.fresh}`));
});

test('without JavaScript the same page reviews with plain forms', async ({ browser, baseURL, seeded }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  await context.addCookies([
    { name: 'pt_session', value: await sessionCookie(baseURL as string, REVIEWER), url: baseURL as string },
  ]);
  const page = await context.newPage();
  await page.goto(`/ui/checks/${seeded.changed}?filter=pending`);
  await expect(page.locator('.pane-baseline img')).toBeVisible();
  await expect(page.locator('.pane-diff img')).toBeVisible();
  await page.getByRole('button', { name: /Approve/ }).click();
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.fresh}\\?filter=pending&done=approved`));
  await expect(page.locator('.flash.notice')).toHaveText('Approved.');
  await page.getByRole('button', { name: /Reject/ }).click();
  await expect(page).toHaveURL(new RegExp(`/ui/builds/${seeded.buildId}\\?done=rejected`));
  await context.close();
});
