// The build page in pages: fitted to the window, paged in place with the keyboard and history,
// reviewed in place on any page, and thumbnails that appear whole once decoded.
import type { Page } from '@playwright/test';
import { Api, expect, open, REVIEWER, type Sessions, screenshot, test } from './fixtures';

/** A build of `count` new screenshots (s00 oldest … newest first on the page). */
async function seedMany(admin: Api, count = 44): Promise<{ buildId: string; ids: string[] }> {
  const slug = `e2e-${Math.random().toString(36).slice(2, 10)}`;
  await admin.call('POST', '/projects', { slug, name: `Many ${slug.slice(4)}` });
  // New projects are members only: the reviewer some tests log in as is added.
  await admin.call('POST', `/projects/${slug}/members`, { email: REVIEWER, role: 'reviewer' });
  const { token } = await admin.call<{ token: string }>('POST', `/projects/${slug}/tokens`, {
    name: 'e2e',
    scopes: ['read', 'write'],
  });
  const ci = new Api(admin.url, { authorization: `Bearer ${token}` });
  const build = await ci.call<{ id: string }>('POST', `/projects/${slug}/builds`, { branch: 'main' });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const shot = screenshot([(i * 37) % 255, 112, 243], 60 + (i % 5) * 20);
    ids.push((await ci.check(build.id, `s${String(i).padStart(2, '0')}`, shot)).id);
  }
  await ci.call('POST', `/builds/${build.id}/finalize`);
  return { buildId: build.id, ids: ids.reverse() };
}

const cardIds = (page: Page) =>
  page.locator('[data-grid] .check-card-wrap').evaluateAll((cards) => cards.map((c) => c.id));
const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.closest('.check-card-wrap')?.id ?? null);
const pageParam = (page: Page) => Number(new URL(page.url()).searchParams.get('page'));

async function reviewer(page: Page, baseURL: string | undefined, sessions: Sessions): Promise<void> {
  await page.context().addCookies([{ name: 'pt_session', value: sessions.reviewer, url: baseURL as string }]);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
]) {
  test(`a page of cards fits ${viewport.width}×${viewport.height} without scrolling`, async ({
    adminPage: page,
    admin,
  }) => {
    const { buildId, ids } = await seedMany(admin);
    await page.setViewportSize(viewport);
    await open(page, `/ui/builds/${buildId}?filter=all`);
    // The page asks for the size that fits, keeping the first card on the page.
    await expect(page).toHaveURL(/size=\d+/);
    const size = Number(new URL(page.url()).searchParams.get('size'));
    expect(size).toBeGreaterThanOrEqual(6);
    await expect(page.locator('[data-grid] .check-card-wrap')).toHaveCount(size);
    expect((await cardIds(page))[0]).toBe(ids[0]);
    const { scroll, inner } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollHeight,
      inner: window.innerHeight,
    }));
    expect(scroll).toBeLessThanOrEqual(inner);
    await expect(page.locator('.page-range')).toHaveText(`1–${size} of 44`);
    await expect(page.locator('.grid-pager')).toBeInViewport({ ratio: 1 });
  });
}

test('[ and ] change pages in place, the address follows, and back and forward work', async ({
  adminPage: page,
  admin,
}) => {
  const { buildId, ids } = await seedMany(admin);
  await open(page, `/ui/builds/${buildId}?filter=all`);
  await expect(page).toHaveURL(/size=\d+/);
  const size = Number(new URL(page.url()).searchParams.get('size'));
  // No full page load from here on: the marker set now would be gone.
  await page.evaluate(() => {
    (window as unknown as { stayed: boolean }).stayed = true;
  });

  await page.keyboard.press(']');
  await expect(page.locator('.page-range')).toHaveText(`${size + 1}–${2 * size} of 44`);
  expect(pageParam(page)).toBe(2);
  expect((await cardIds(page))[0]).toBe(ids[size]);
  await page.keyboard.press(']');
  await expect(page.locator('[data-pager]')).toHaveAttribute('data-page', '3');
  await page.keyboard.press('[');
  await expect(page.locator('[data-pager]')).toHaveAttribute('data-page', '2');

  await page.goBack();
  await expect(page.locator('[data-pager]')).toHaveAttribute('data-page', '3');
  expect(pageParam(page)).toBe(3);
  await page.goBack();
  await expect(page.locator('[data-pager]')).toHaveAttribute('data-page', '2');
  await page.goForward();
  await expect(page.locator('[data-pager]')).toHaveAttribute('data-page', '3');

  // The page numbers are links that change the page in place too.
  await page.locator('.page-numbers a', { hasText: /^1$/ }).click();
  await expect(page.locator('[data-pager]')).toHaveAttribute('data-page', '1');
  expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);

  // The ? sheet lists the page keys.
  await page.keyboard.press('?');
  await expect(page.locator('#shortcut-sheet')).toContainText('Next page');
  await expect(page.locator('#shortcut-sheet')).toContainText('Previous page');
});

test('J, K and the arrows move between cards and on to the next or previous page at the edges', async ({
  adminPage: page,
  admin,
}) => {
  const { buildId, ids } = await seedMany(admin);
  await open(page, `/ui/builds/${buildId}?filter=all`);
  await expect(page).toHaveURL(/size=\d+/);
  const size = Number(new URL(page.url()).searchParams.get('size'));

  await page.keyboard.press('j');
  expect(await focusedId(page)).toBe(ids[0]);
  await page.keyboard.press('ArrowRight');
  expect(await focusedId(page)).toBe(ids[1]);
  for (let i = 2; i < size; i++) await page.keyboard.press('j');
  expect(await focusedId(page)).toBe(ids[size - 1]);

  // Past the last card: the next page, its first card.
  await page.keyboard.press('j');
  await expect(page.locator('[data-pager]')).toHaveAttribute('data-page', '2');
  await expect.poll(() => focusedId(page)).toBe(ids[size]);
  // Before the first: back to the last card of the page before.
  await page.keyboard.press('k');
  await expect(page.locator('[data-pager]')).toHaveAttribute('data-page', '1');
  await expect.poll(() => focusedId(page)).toBe(ids[size - 1]);
  // ↑ from the first row goes to the previous page; ↓ from the last row to the next one.
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-pager]')).toHaveAttribute('data-page', '2');
});

test('a card on page 2 is approved in place with A, stays where it is, and U undoes it', async ({
  page,
  admin,
  baseURL,
  sessions,
}) => {
  await reviewer(page, baseURL, sessions);
  const { buildId, ids } = await seedMany(admin);
  await open(page, `/ui/builds/${buildId}?filter=pending`);
  await expect(page).toHaveURL(/size=\d+/);
  const size = Number(new URL(page.url()).searchParams.get('size'));
  await page.keyboard.press(']');
  await expect(page.locator('[data-pager]')).toHaveAttribute('data-page', '2');
  await page.evaluate(() => {
    (window as unknown as { stayed: boolean }).stayed = true;
  });

  // ] put the focus on the page's first card.
  const target = ids[size] as string;
  await expect.poll(() => focusedId(page)).toBe(target);
  const card = page.locator(`[id="${target}"]`);
  const before = await card.boundingBox();
  await page.keyboard.press('a');
  await expect(page.locator('.toast').last()).toContainText('Approved s');
  // Under Unresolved the approved card stays in place, resolved, until the page changes.
  await expect(card.locator('.card-state')).toHaveText('resolved');
  expect(await card.boundingBox()).toEqual(before);
  expect(await focusedId(page)).toBe(target);
  expect(pageParam(page)).toBe(2);

  await page.keyboard.press('u');
  await expect(page.locator('.toast').last()).toContainText('Review undone');
  await expect(card.locator('.card-state')).toHaveText('unresolved');

  // Approved again, then the next page: this page fills up first, so nothing is skipped.
  await page.keyboard.press('a');
  await expect(card.locator('.card-state')).toHaveText('resolved');
  await page.keyboard.press(']');
  await expect(page.locator(`[id="${target}"]`)).toHaveCount(0);
  await expect(page.locator('[data-pager]')).toHaveAttribute('data-page', '2');
  expect((await cardIds(page))[0]).toBe(ids[size + 1]);
  await expect(page.locator('.page-range')).toContainText('of 43');
  expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);
});

test('a thumbnail shimmers in its final box until it is decoded, then shows without moving', async ({
  adminPage: page,
  admin,
}) => {
  const { buildId, ids } = await seedMany(admin, 6);
  // Hold the first card's thumbnail back until the test lets it through.
  const html = await (await page.request.get(`/ui/builds/${buildId}?filter=all`)).text();
  const first = /<img src="([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&') ?? '';
  expect(first).toContain('/thumb?w=640');
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/images/*/thumb*', async (route) => {
    if (route.request().url().endsWith(first)) await held;
    await route.continue();
  });

  await open(page, `/ui/builds/${buildId}?filter=all`);
  // Fitted to the window first (the size goes into the address), then measured.
  await expect(page).toHaveURL(/size=\d+/);
  const stack = page.locator(`[id="${ids[0]}"] .thumb-stack`);
  const img = stack.locator('img');
  const box = stack.locator('.thumb-box');
  const waiting = await box.boundingBox();
  expect(waiting?.width).toBeGreaterThan(50);
  expect(waiting?.height).toBeGreaterThan(30);
  await expect(img).not.toHaveClass(/is-loaded/);
  expect(await img.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  expect(await box.evaluate((el) => getComputedStyle(el).animationName)).toBe('skeleton');
  // The other thumbnails are decoded and shown meanwhile.
  await expect(page.locator(`[id="${ids[1]}"] img`)).toHaveClass(/is-loaded/);

  release();
  await expect(img).toHaveClass(/is-loaded/);
  await expect.poll(() => img.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  // Nothing moved: the box is where it was, and the image lies on it (to a fraction of a pixel).
  expect(await box.boundingBox()).toEqual(waiting);
  const shown = await img.boundingBox();
  for (const k of ['x', 'y', 'width', 'height'] as const)
    expect(Math.abs((shown?.[k] ?? 0) - (waiting?.[k] ?? 0))).toBeLessThan(0.5);
  expect(await box.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});

test('a thumbnail that fails shows a calm placeholder in its box', async ({ adminPage: page, admin }) => {
  const { buildId, ids } = await seedMany(admin, 4);
  await page.route('**/api/v1/images/*/thumb*', (route) => route.fulfill({ status: 500, body: 'no' }));
  await open(page, `/ui/builds/${buildId}?filter=all`);
  const stack = page.locator(`[id="${ids[0]}"] .thumb-stack`);
  await expect(stack.locator('img')).toHaveClass(/is-broken/);
  expect(await stack.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('"No image"');
  expect((await stack.boundingBox())?.height).toBeGreaterThan(30);
});
