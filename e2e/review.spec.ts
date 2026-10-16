import { expect, open, test } from './fixtures';

interface CheckJson {
  review: string;
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

test('toasts appear top right, all the same size, in the colour of what happened, never over the buttons', async ({
  reviewerPage: page,
  seeded,
}) => {
  await open(page, `/ui/checks/${seeded.changed}?filter=pending`);
  await page.keyboard.press('a');
  const approved = page.locator('.toast').last();
  await expect(approved).toHaveClass(/tone-success/);
  const toast = await approved.boundingBox();
  const button = await page.getByRole('button', { name: /Approve/ }).boundingBox();
  if (!toast || !button) throw new Error('toast or button not on screen');
  const apart =
    toast.x + toast.width <= button.x ||
    button.x + button.width <= toast.x ||
    toast.y + toast.height <= button.y ||
    button.y + button.height <= toast.y;
  expect(apart).toBe(true);
  expect(toast.y).toBeLessThan(200);
  const viewport = page.viewportSize();
  expect(viewport && toast.x + toast.width).toBeGreaterThan((viewport?.width ?? 0) - 40);

  await page.keyboard.press('r');
  const rejected = page.locator('.toast.tone-danger');
  await expect(rejected).toHaveCount(1);
  const other = await rejected.boundingBox();
  expect(other && [other.width, other.height]).toEqual([toast.width, toast.height]);
});

test('a reviewer draws an ignore area over the change; the check is compared again at once', async ({
  reviewerPage: page,
  seeded,
}) => {
  await open(page, `/ui/checks/${seeded.changed}?filter=all`);
  await expect(page.locator('.review-head')).toContainText('changed');
  await page.keyboard.press('i');
  await expect(page.locator('#stage')).toHaveAttribute('data-drawing', 'ignore');
  // The red button sits at (40,220), 130×30, on the 480×300 screenshot; drag around it.
  const img = page.locator('.pane-overlay img.layer-top');
  const box = await img.boundingBox();
  if (!box) throw new Error('screenshot not on screen');
  const at = (x: number, y: number) => ({ x: box.x + (x / 480) * box.width, y: box.y + (y / 300) * box.height });
  const from = at(30, 210);
  const to = at(190, 260);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.toast').last()).toContainText('Ignore area added');
  await expect(page.locator('.review-head')).toContainText('unchanged');
  await expect(page.locator('.area-item')).toHaveCount(1);
  await expect(page.locator('.pane-current .area-ignore')).toHaveCount(1);

  // Click the area to edit it: drag it off the button, Save, and the change is back.
  const shown = await img.boundingBox();
  if (!shown) throw new Error('screenshot not on screen');
  const on = (x: number, y: number) => ({
    x: shown.x + (x / 480) * shown.width,
    y: shown.y + (y / 300) * shown.height,
  });
  const grip = on(110, 235);
  await page.mouse.click(grip.x, grip.y);
  const editor = page.locator('.area-editor');
  await expect(editor).toBeVisible();
  await expect(page.locator('.area-edit-bar')).toBeVisible();
  // Entering edit mode must not move the screenshot under the pointer.
  expect(await img.boundingBox()).toEqual(shown);
  const away = on(110, 110);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(away.x, away.y, { steps: 5 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Save area' }).click();
  await expect(page.locator('.toast').last()).toContainText('Area updated');
  await expect(page.locator('.review-head')).toContainText('changed');
  await expect(page.locator('.area-editor')).toHaveCount(0);
  await expect(page.locator('.area-item')).toHaveCount(1);

  // Esc leaves editing without saving.
  await page.locator('.area-item').getByRole('button', { name: 'Edit this area' }).click();
  await expect(page.locator('.area-editor')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.area-editor')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.changed}`));

  await page.locator('.area-item').getByRole('button', { name: 'Delete this area' }).click();
  await expect(page.locator('.toast').last()).toContainText('Area deleted');
  await expect(page.locator('.area-item')).toHaveCount(0);
  await expect(page.locator('.review-head')).toContainText('changed');
});

test('Ignore next to a change adds an ignore area over it at once', async ({ reviewerPage: page, seeded }) => {
  await open(page, `/ui/checks/${seeded.changed}?filter=all`);
  await expect(page.locator('.review-head')).toContainText('changed');
  await page.getByRole('button', { name: 'Ignore change 1' }).click();
  await expect(page.locator('.toast').last()).toContainText('Ignore area added');
  await expect(page.locator('.review-head')).toContainText('unchanged');
  await expect(page.locator('.area-item')).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.changed}`));
});

test('an edited area saves itself 10 seconds after the last change', async ({ reviewerPage: page, seeded }) => {
  await page.clock.install();
  await open(page, `/ui/checks/${seeded.changed}?filter=all`);
  const added = await seeded.ci.call<{ area: { id: string } }>('POST', `/checks/${seeded.changed}/areas`, {
    kind: 'ignore',
    x: 30,
    y: 210,
    width: 160,
    height: 50,
  });
  await open(page, `/ui/checks/${seeded.changed}?filter=all`);
  await page.locator('.area-item').getByRole('button', { name: 'Edit this area' }).click();
  await expect(page.locator('.area-editor')).toBeVisible();
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  await expect(page.locator('.area-edit-bar')).toContainText('Saves itself in 10 s');
  await page.clock.runFor(9_000);
  await expect(page.locator('.area-editor')).toBeVisible();
  await page.clock.runFor(1_500);
  await expect(page.locator('.toast').last()).toContainText('Area updated');
  await expect(page.locator('.area-editor')).toHaveCount(0);
  const areas = await seeded.ci.call<{ items: Array<{ id: string; y: number }> }>(
    'GET',
    `/checks/${seeded.changed}/areas`,
  );
  expect(areas.items).toEqual([expect.objectContaining({ id: added.area.id, y: 190 })]);
});

test('R rejects the check and moves on', async ({ reviewerPage: page, seeded }) => {
  await open(page, `/ui/checks/${seeded.changed}?filter=pending`);
  await page.keyboard.press('r');
  await expect(page.locator('.toast').last()).toContainText('Rejected home');
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.fresh}`));
  expect((await seeded.ci.call<CheckJson>('GET', `/checks/${seeded.changed}`)).review).toBe('rejected');
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

test('without JavaScript the same page reviews with plain forms', async ({ browser, baseURL, sessions, seeded }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  await context.addCookies([{ name: 'pt_session', value: sessions.reviewer, url: baseURL as string }]);
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
