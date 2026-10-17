import { makePng, WHITE } from '../test/helpers/png';
import { expect, open, test } from './fixtures';

interface CheckJson {
  review: string;
}

test('a reviewer goes through a build with the keyboard, without page loads', async ({
  reviewerPage: page,
  seeded,
}) => {
  // Newest first: the new cart page (posted last) comes before the changed home page.
  await open(page, `/ui/checks/${seeded.fresh}?filter=pending`);
  await page.evaluate(() => {
    (window as unknown as { stayed: boolean }).stayed = true;
  });
  await expect(page.locator('.review-position')).toHaveText('1 / 2');
  // The whole review fits the window: the filmstrip and the action bar are fully visible.
  await expect(page.locator('.frame').first()).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: /Approve/ })).toBeInViewport({ ratio: 1 });

  await page.keyboard.press('a');
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.changed}`));
  await expect(page.locator('.toast').last()).toContainText('Approved cart');

  // Undo goes back to the check and makes it pending again.
  await page.keyboard.press('u');
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.fresh}`));
  expect((await seeded.ci.call<CheckJson>('GET', `/checks/${seeded.fresh}`)).review).toBe('pending');

  await page.keyboard.press('a');
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.changed}`));
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

test('one toast at a time, above the action bar on the check page, in the colour of what happened, never over a button', async ({
  reviewerPage: page,
  seeded,
}) => {
  await open(page, `/ui/checks/${seeded.changed}?filter=pending`);
  await page.keyboard.press('a');
  const approved = page.locator('.toast').last();
  await expect(approved).toHaveClass(/tone-success/);
  // Measured once its entry animation has settled.
  await page.waitForTimeout(300);
  const toast = await approved.boundingBox();
  const bar = await page.locator('.action-bar').boundingBox();
  if (!toast || !bar) throw new Error('toast or action bar not on screen');
  expect(toast.y + toast.height).toBeLessThanOrEqual(bar.y);
  const viewport = page.viewportSize()?.width ?? 0;
  expect(Math.abs(toast.x + toast.width / 2 - viewport / 2)).toBeLessThan(2);
  for (const button of await page.locator('button:visible, a.button:visible').all()) {
    // The toast's own Undo and close buttons are on it, of course.
    if (await button.evaluate((el) => el.closest('.toast') !== null)) continue;
    const b = await button.boundingBox();
    if (!b) continue;
    const apart =
      toast.x + toast.width <= b.x ||
      b.x + b.width <= toast.x ||
      toast.y + toast.height <= b.y ||
      b.y + b.height <= toast.y;
    expect(apart, (await button.getAttribute('class')) ?? '').toBe(true);
  }

  await page.keyboard.press('r');
  const rejected = page.locator('.toast.tone-danger');
  await expect(rejected).toHaveCount(1);
  // The new toast replaced the first one, at the same size.
  await expect(page.locator('.toast')).toHaveCount(1);
  await expect
    .poll(async () => {
      const other = await rejected.boundingBox();
      return other && [Math.round(other.width), Math.round(other.height)];
    })
    .toEqual([Math.round(toast.width), Math.round(toast.height)]);
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
  await expect(page.locator('.review-head .status')).toHaveText('passed');
  await expect(page.locator('.area-item')).toHaveCount(1);
  await expect(page.locator('.pane-current .area-ignore')).toHaveCount(1);

  // Areas are this build's: in Slider they show on its side of the divider only, so move the
  // divider all the way left before picking the area.
  for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowLeft');
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
  await expect(page.locator('.review-head .status')).toHaveText('passed');
  await expect(page.locator('.area-item')).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.changed}`));
});

test('an edited area saves itself 5 seconds after the last change, counting down in a ring', async ({
  reviewerPage: page,
  seeded,
}) => {
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
  const countdown = page.locator('[data-autosave]');
  await expect(countdown).toBeVisible();
  await expect(countdown).toHaveText('5s');
  await expect(countdown).toHaveAttribute('aria-label', 'Saves itself in 5 s');
  await page.clock.runFor(2_000);
  await expect(countdown).toHaveText('3s');
  // Another change starts the countdown again.
  await page.keyboard.press('Shift+ArrowUp');
  await expect(countdown).toHaveText('5s');
  await page.clock.runFor(4_000);
  await expect(page.locator('.area-editor')).toBeVisible();
  await page.clock.runFor(1_500);
  await expect(page.locator('.toast').last()).toContainText('Area updated');
  await expect(page.locator('.area-editor')).toHaveCount(0);
  const areas = await seeded.ci.call<{ items: Array<{ id: string; y: number }> }>(
    'GET',
    `/checks/${seeded.changed}/areas`,
  );
  expect(areas.items).toEqual([expect.objectContaining({ id: added.area.id, y: 180 })]);
});

test('an older build cannot approve a screen a newer build already approved', async ({
  reviewerPage: page,
  seeded,
}) => {
  // A newer build of main posts the same changed screen and gets it approved.
  const newer = await seeded.ci.call<{ id: string }>('POST', `/projects/${seeded.slug}/builds`, { branch: 'main' });
  const old = await seeded.ci.call<{ name: string; variant: Record<string, string>; links: { image: string } }>(
    'GET',
    `/checks/${seeded.changed}`,
  );
  const image = await (await page.request.get(old.links.image)).body();
  const check = await seeded.ci.call<{ id: string }>('POST', `/builds/${newer.id}/checks`, {
    name: old.name,
    variant: old.variant,
    imageBase64: image.toString('base64'),
  });
  await seeded.ci.call('POST', `/checks/${check.id}/approve`);

  await open(page, `/ui/checks/${seeded.changed}?filter=all`);
  await expect(page.locator('.review-head')).toContainText('outdated');
  await expect(page.locator('.outdated-note')).toContainText('already approved this screen');
  await expect(page.getByRole('button', { name: /Approve/ })).toHaveCount(0);
  await page.locator('.outdated-note a').click();
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${check.id}`));
});

test('zooming keeps the toolbar still: Ignore and Compare do not move as the zoom label changes', async ({
  reviewerPage: page,
  seeded,
}) => {
  await open(page, `/ui/checks/${seeded.changed}?filter=all`);
  const ignore = page.locator('[data-draw="ignore"]');
  const before = await ignore.boundingBox();
  const stage = await page.locator('.pane-overlay .viewport').boundingBox();
  if (!before || !stage) throw new Error('toolbar or stage not on screen');
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  for (const delta of [-300, -300, -600, 200]) {
    await page.mouse.wheel(0, delta);
    await expect(page.locator('[data-zoom-label]')).not.toHaveText('Fit');
    expect((await ignore.boundingBox())?.x).toBe(before.x);
  }
});

test('R rejects the check and moves on', async ({ reviewerPage: page, seeded }) => {
  await open(page, `/ui/checks/${seeded.changed}?filter=pending`);
  await page.keyboard.press('r');
  await expect(page.locator('.toast').last()).toContainText('Rejected home');
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.fresh}`));
  expect((await seeded.ci.call<CheckJson>('GET', `/checks/${seeded.changed}`)).review).toBe('rejected');
});

test('arrow keys move between checks; Shift+arrows move the slider', async ({ reviewerPage: page, seeded }) => {
  // Newest first: ← goes to the newer check (the new cart page), → back to the older one.
  await open(page, `/ui/checks/${seeded.changed}?filter=pending`);
  await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${seeded.fresh}`));
  await page.keyboard.press('ArrowRight');
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

test.describe('on a short screen', () => {
  test.use({ viewport: { width: 1000, height: 420 } });

  test('Approve on a build card approves in place: no page load, no scroll', async ({ reviewerPage: page, seeded }) => {
    await open(page, `/ui/builds/${seeded.buildId}`);
    const card = page.locator(`[id="${seeded.fresh}"]`);
    await card.scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 40);
    await page.evaluate(() => {
      (window as unknown as { stayed: boolean }).stayed = true;
    });
    const height = () => page.evaluate(() => document.documentElement.scrollHeight);
    const heightBefore = await height();
    const before = (await card.boundingBox())?.y ?? 0;
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(page.locator('.toast').last()).toContainText('Approved cart');
    await expect(card.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(card).toContainText('resolved');
    expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);
    const after = (await card.boundingBox())?.y ?? 0;
    // Scrolled to the end, the page ends earlier without the Approve row and the card moves by as
    // much; a reload jumped it to the top of the window.
    expect(Math.abs(after - before)).toBeLessThanOrEqual(heightBefore - (await height()) + 1);
    expect(page.url()).not.toContain('#');
    const check = await seeded.ci.call<CheckJson>('GET', `/checks/${seeded.fresh}`);
    expect(check.review).toBe('approved');
  });
});

test('Ignore keeps the list of changes as it was; Ignore all clears the rest in one go', async ({
  reviewerPage: page,
  seeded,
}) => {
  const grid = (blobs: number) =>
    makePng(600, 900, WHITE, [
      ...Array.from({ length: blobs }, (_, i) => ({
        x: 40 + (i % 3) * 180,
        y: 140 + Math.floor(i / 3) * 160,
        width: 120,
        height: 60,
        color: [229, 72, 77, 255] as [number, number, number, number],
      })),
    ]);
  const first = await seeded.ci.call<{ id: string }>('POST', `/projects/${seeded.slug}/builds`, { branch: 'main' });
  await seeded.ci.check(first.id, 'grid', grid(0));
  await seeded.ci.call('POST', `/builds/${first.id}/approve`);
  const next = await seeded.ci.call<{ id: string }>('POST', `/projects/${seeded.slug}/builds`, { branch: 'main' });
  const check = await seeded.ci.check(next.id, 'grid', grid(5));

  await open(page, `/ui/checks/${check.id}?filter=all`);
  const changes = page.locator('details.changes');
  // Five changes start folded; the reviewer opens the list.
  await expect(changes).not.toHaveAttribute('open', '');
  await changes.locator('summary').click();
  await page.getByRole('button', { name: 'Ignore change 1' }).click();
  await expect(page.locator('.toast').last()).toContainText('Ignore area added');
  await expect(changes.locator('summary .count')).toHaveText('4');
  await expect(changes).toHaveAttribute('open', '');

  await page.getByRole('button', { name: 'Ignore all 4 changes' }).click();
  await expect(page.locator('.toast').last()).toContainText('Ignored 4 changes');
  await expect(page.locator('details.changes')).toHaveCount(0);
  expect((await seeded.ci.call<{ result: string }>('GET', `/checks/${check.id}`)).result).toBe('unchanged');
});

test('Show diff shows what the areas hide and back, in place', async ({ reviewerPage: page, seeded }) => {
  await seeded.ci.call('POST', `/checks/${seeded.changed}/areas`, {
    kind: 'ignore',
    x: 0,
    y: 0,
    width: 480,
    height: 300,
  });
  await open(page, `/ui/checks/${seeded.changed}?filter=all`);
  await page.evaluate(() => {
    (window as unknown as { stayed: boolean }).stayed = true;
    sessionStorage.setItem('pixeltwin.review.highlight.session', 'off');
  });
  await expect(page.locator('.areas.is-off')).toHaveCount(0);
  await expect(page.locator('.areas-toggle')).toHaveText('Show diff');
  // The slider divider moved by the reviewer stays where it is: nothing jumps.
  await page.locator('[data-mode-button="slider"]').click();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  const divider = () => page.locator('.divider').evaluate((el) => (el as HTMLElement).style.left);
  const moved = await divider();
  expect(moved).toBe('60%');
  // Show diff and the tools on the right of the toolbar stay where they are.
  const where = async () =>
    Promise.all(
      ['.areas-toggle', '.stage-actions', '.draw-tools', '.zoom-controls', '.review-info .areas'].map(
        async (selector) => {
          const box = await page.locator(selector).boundingBox();
          return [selector, Math.round(box?.x ?? -1), Math.round(box?.y ?? -1), Math.round(box?.width ?? -1)];
        },
      ),
    );
  const before = await where();
  await page.locator('.areas-toggle').click();
  await expect(page.locator('.areas.is-off')).toBeVisible();
  await expect(page).toHaveURL(/areas=off/);
  expect(await divider()).toBe(moved);
  // The button stays under the pointer.
  expect(await where()).toEqual(before);
  await expect(page.locator('.pane-diff img')).toHaveCount(1);
  // Show diff is there to see the changes: they are highlighted even if Changes was off.
  await expect(page.locator('[data-highlight]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.areas-toggle').click();
  await expect(page.locator('.areas.is-off')).toHaveCount(0);
  await expect(page).not.toHaveURL(/areas=off/);
  expect(await where()).toEqual(before);
  expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);
});

test('Changes is on whenever a check is opened anew, and off only for the tab that turned it off', async ({
  reviewerPage: page,
  seeded,
}) => {
  await open(page, `/ui/checks/${seeded.changed}?filter=all`);
  const toggle = page.locator('[data-highlight]');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('h');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // The same tab keeps the choice from check to check…
  await open(page, `/ui/checks/${seeded.changed}?filter=all`);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // …a new tab starts with the changes highlighted.
  const other = await page.context().newPage();
  await open(other, `/ui/checks/${seeded.changed}?filter=all`);
  await expect(other.locator('[data-highlight]')).toHaveAttribute('aria-pressed', 'true');
  await other.close();
});

/** The areas of a check through the API, in the order they were added. */
async function areasOf(seeded: { ci: { call: <T>(method: string, path: string) => Promise<T> } }, checkId: string) {
  const { items } = await seeded.ci.call<{ items: Array<{ x: number; y: number; width: number; height: number }> }>(
    'GET',
    `/checks/${checkId}/areas`,
  );
  return items.map(({ x, y, width, height }) => ({ x, y, width, height }));
}

test('Alt+drag on an area drags out a copy of the same size; the original stays and the check is compared again', async ({
  reviewerPage: page,
  seeded,
}) => {
  // Right of the changed button, so the check still has its change.
  await seeded.ci.call('POST', `/checks/${seeded.changed}/areas`, {
    kind: 'ignore',
    x: 300,
    y: 210,
    width: 160,
    height: 50,
  });
  await open(page, `/ui/checks/${seeded.changed}?filter=all`);
  await expect(page.locator('.review-head .status')).not.toHaveText('passed');
  await page.keyboard.press('1');
  const img = page.locator('.pane-current img').first();
  const box = await img.boundingBox();
  if (!box) throw new Error('screenshot not on screen');
  const at = (x: number, y: number) => ({ x: box.x + (x / 480) * box.width, y: box.y + (y / 300) * box.height });
  const grab = at(380, 235);
  const drop = at(110, 235);
  await page.keyboard.down('Alt');
  await page.mouse.move(grab.x, grab.y);
  // The copy cursor shows while Alt is held over the areas.
  await expect(page.locator('#stage')).toHaveAttribute('data-copying', '');
  await page.mouse.down();
  await page.mouse.move(drop.x, drop.y, { steps: 8 });
  await expect(page.locator('.area-ghost')).toHaveCount(1);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(page.locator('.toast').last()).toContainText('Area duplicated');
  // The copy covers the change: compared again, the check passes.
  await expect(page.locator('.review-head .status')).toHaveText('passed');
  await expect(page.locator('.area-item')).toHaveCount(2);
  // The copy comes back picked, to be nudged into place.
  await expect(page.locator('.area-editor')).toBeVisible();
  const saved = await areasOf(seeded, seeded.changed);
  expect(saved).toHaveLength(2);
  expect(saved[0]).toEqual({ x: 300, y: 210, width: 160, height: 50 });
  // The drop is in screen pixels: allow a pixel of rounding.
  expect(saved[1]?.width).toBe(160);
  expect(saved[1]?.height).toBe(50);
  expect(Math.abs((saved[1]?.x ?? 0) - 30)).toBeLessThanOrEqual(1);
  expect(Math.abs((saved[1]?.y ?? 0) - 210)).toBeLessThanOrEqual(1);

  await open(page, `/ui/checks/${seeded.changed}?filter=all`);
  await expect(page.locator('.area-item')).toHaveCount(2);
  await expect(page.locator('.review-head .status')).toHaveText('passed');
  // Show diff: nothing can be drawn, so nothing can be duplicated either.
  await expect(page.locator('[data-area-duplicate]')).toHaveCount(2);
  await page.locator('.areas-toggle').click();
  await expect(page.locator('.areas.is-off')).toBeVisible();
  await expect(page.locator('[data-area-duplicate]')).toHaveCount(0);
});

test('Cmd/Ctrl+D duplicates the picked area below it; arrows nudge it; Cmd/Ctrl+D repeats the move; Cmd/Ctrl+Z takes it back', async ({
  reviewerPage: page,
  seeded,
}) => {
  await seeded.ci.call('POST', `/checks/${seeded.changed}/areas`, {
    kind: 'ignore',
    x: 300,
    y: 40,
    width: 120,
    height: 20,
  });
  await open(page, `/ui/checks/${seeded.changed}?filter=all`);
  await page.keyboard.press('1');
  // The shortcuts are in the ? sheet.
  await page.keyboard.press('?');
  const sheet = page.locator('#shortcut-sheet');
  await expect(sheet).toContainText('Duplicate the picked area');
  await expect(sheet).toContainText('Duplicate an area: drag the copy where it goes');
  await expect(sheet).toContainText('Nudge the picked area 10 px');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  await page.locator('.area-item').getByRole('button', { name: 'Edit this area' }).click();
  await expect(page.locator('.area-editor')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+d');
  await expect(page.locator('.toast').last()).toContainText('Area duplicated');
  await expect(page.locator('.area-item')).toHaveCount(2);
  await expect(page.locator('.area-editor')).toBeVisible();
  expect(await areasOf(seeded, seeded.changed)).toEqual([
    { x: 300, y: 40, width: 120, height: 20 },
    { x: 300, y: 68, width: 120, height: 20 },
  ]);

  // The copy is picked: nudge it 1 px right and 10 px down, then duplicate it again. The move is
  // saved first, and the next copy repeats the step from the original to the moved copy.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('ControlOrMeta+d');
  await expect(page.locator('.area-item')).toHaveCount(3);
  expect(await areasOf(seeded, seeded.changed)).toEqual([
    { x: 300, y: 40, width: 120, height: 20 },
    { x: 301, y: 78, width: 120, height: 20 },
    { x: 302, y: 116, width: 120, height: 20 },
  ]);

  // Cmd/Ctrl+Z removes the duplicate just made.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.toast').last()).toContainText('Duplicate removed');
  await expect(page.locator('.area-item')).toHaveCount(2);

  await open(page, `/ui/checks/${seeded.changed}?filter=all`);
  await expect(page.locator('.area-item')).toHaveCount(2);
  expect(await areasOf(seeded, seeded.changed)).toEqual([
    { x: 300, y: 40, width: 120, height: 20 },
    { x: 301, y: 78, width: 120, height: 20 },
  ]);
  // Delete removes the picked area.
  await page.locator('.area-item').last().getByRole('button', { name: 'Edit this area' }).click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.toast').last()).toContainText('Area deleted');
  await expect(page.locator('.area-item')).toHaveCount(1);
});

test('Duplicate at the area limit says so and adds nothing', async ({ reviewerPage: page, seeded }) => {
  for (let i = 0; i < 50; i++) {
    await seeded.ci.call('POST', `/checks/${seeded.changed}/areas`, {
      kind: 'ignore',
      x: (i % 10) * 40,
      y: Math.floor(i / 10) * 30,
      width: 20,
      height: 10,
    });
  }
  await open(page, `/ui/checks/${seeded.changed}?filter=all`);
  await expect(page.locator('.area-item')).toHaveCount(50);
  await page.locator('.area-item').first().getByRole('button', { name: 'Duplicate this area' }).click();
  await expect(page.locator('.toast').last()).toContainText('already has 50 areas');
  await expect(page.locator('.area-item')).toHaveCount(50);
  expect(await areasOf(seeded, seeded.changed)).toHaveLength(50);
});
