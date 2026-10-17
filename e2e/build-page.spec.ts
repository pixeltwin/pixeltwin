// The build page in pages: fitted to the window, paged in place with the keyboard and history,
// reviewed in place on any page, and thumbnails that appear whole once decoded.
import type { Page } from '@playwright/test';
import { BLACK, makePng, WHITE } from '../test/helpers/png';
import { Api, expect, open, REVIEWER, type Sessions, screenshot, test } from './fixtures';

/** A project of its own, with the reviewer as a member and a CI token that may review. */
async function project(admin: Api): Promise<{ slug: string; ci: Api }> {
  const slug = `e2e-${Math.random().toString(36).slice(2, 10)}`;
  await admin.call('POST', '/projects', { slug, name: `Many ${slug.slice(4)}` });
  // New projects are members only: the reviewer some tests log in as is added.
  await admin.call('POST', `/projects/${slug}/members`, { email: REVIEWER, role: 'reviewer' });
  const { token } = await admin.call<{ token: string }>('POST', `/projects/${slug}/tokens`, {
    name: 'e2e',
    scopes: ['read', 'write', 'review'],
  });
  return { slug, ci: new Api(admin.url, { authorization: `Bearer ${token}` }) };
}

/** A build of `count` new screenshots (s00 oldest … newest first on the page). */
async function seedMany(
  admin: Api,
  count = 44,
  shotOf: (i: number) => Uint8Array<ArrayBuffer> = (i) => screenshot([(i * 37) % 255, 112, 243], 60 + (i % 5) * 20),
): Promise<{ buildId: string; ids: string[] }> {
  const { slug, ci } = await project(admin);
  const build = await ci.call<{ id: string }>('POST', `/projects/${slug}/builds`, { branch: 'main' });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push((await ci.check(build.id, `s${String(i).padStart(2, '0')}`, shotOf(i))).id);
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

/** A desktop browser's screenshot: wider than the largest thumbnail, with text-like lines. */
const desktopShot = (i: number) =>
  makePng(1280, 800, WHITE, [
    { x: 0, y: 0, width: 1280, height: 64, color: [17, 17, 17, 255] },
    { x: 48, y: 120, width: 400 + (i % 7) * 40, height: 28, color: BLACK },
    ...Array.from({ length: 12 }, (_, k) => ({
      x: 48,
      y: 200 + k * 40,
      width: 1100 - k * 30,
      height: 4,
      color: BLACK,
    })),
  ]);

const densityCookie = (baseURL: string | undefined, value: 'large' | 'compact') => ({
  name: 'pt_density',
  value,
  url: baseURL as string,
});

// Large cards (the default) are fewer; compact ones as many as before. The columns each fits:
const COLUMNS: Record<string, { large: number; compact: number }> = {
  '1280': { large: 3, compact: 4 },
  '1440': { large: 3, compact: 5 },
  '1920': { large: 4, compact: 6 },
  '2560': { large: 4, compact: 6 },
};

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]) {
  for (const density of ['large', 'compact'] as const) {
    test(`a page of ${density} cards fits ${viewport.width}×${viewport.height} without scrolling`, async ({
      adminPage: page,
      admin,
      baseURL,
    }) => {
      const { buildId, ids } = await seedMany(admin);
      await page.context().addCookies([densityCookie(baseURL, density)]);
      await page.setViewportSize(viewport);
      await open(page, `/ui/builds/${buildId}?filter=all`);
      // The page asks for the size that fits, keeping the first card on the page.
      await expect(page).toHaveURL(/size=\d+/);
      const size = Number(new URL(page.url()).searchParams.get('size'));
      const columns = COLUMNS[String(viewport.width)]?.[density] as number;
      expect(
        await page.locator('[data-grid]').evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(' ').length),
      ).toBe(columns);
      // Whole rows: at least one of large cards, two of compact ones.
      expect(size % columns).toBe(0);
      expect(size).toBeGreaterThanOrEqual(density === 'large' ? columns : 2 * columns);
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
}

test.describe('on a 2× screen', () => {
  test.use({ deviceScaleFactor: 2 });

  for (const density of ['large', 'compact'] as const) {
    test(`${density} cards get thumbnails as sharp as the screen`, async ({ adminPage: page, admin, baseURL }) => {
      const { buildId } = await seedMany(admin, 8, desktopShot);
      await page.context().addCookies([densityCookie(baseURL, density)]);
      await open(page, `/ui/builds/${buildId}?filter=all`);
      await expect(page).toHaveURL(/size=\d+/);
      const images = page.locator('[data-grid] .thumb-stack img');
      await expect(images.first()).toHaveClass(/is-loaded/);
      await expect(images.last()).toHaveClass(/is-loaded/);
      // The file the browser picked from srcset, in pixels, against the box it is shown in.
      const shown = await images.evaluateAll((list) =>
        Promise.all(
          (list as HTMLImageElement[]).map(async (img) => {
            const file = new Image();
            file.src = img.currentSrc;
            await file.decode();
            return { file: file.naturalWidth, needed: img.getBoundingClientRect().width * devicePixelRatio };
          }),
        ),
      );
      expect(shown.length).toBeGreaterThan(0);
      for (const { file, needed } of shown) expect(file).toBeGreaterThanOrEqual(Math.floor(needed));
      // Large cards need the 960 px thumbnails; compact ones the 640 px ones.
      expect(shown[0]?.file).toBe(density === 'large' ? 960 : 640);
    });
  }
});

test('the density switch changes the cards in place, by mouse or keyboard, and is remembered', async ({
  adminPage: page,
  admin,
}) => {
  const { buildId, ids } = await seedMany(admin);
  await open(page, `/ui/builds/${buildId}?filter=all`);
  await expect(page).toHaveURL(/size=\d+/);
  const grid = page.locator('[data-grid]');
  await expect(grid).toHaveAttribute('data-density', 'large');
  const large = Number(new URL(page.url()).searchParams.get('size'));
  await page.evaluate(() => {
    (window as unknown as { stayed: boolean }).stayed = true;
  });
  const compactButton = page.getByRole('button', { name: 'Compact' });
  await compactButton.focus();
  await page.keyboard.press('Enter');
  await expect(grid).toHaveAttribute('data-density', 'compact');
  await expect(compactButton).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => Number(new URL(page.url()).searchParams.get('size'))).toBeGreaterThan(large);
  const compact = Number(new URL(page.url()).searchParams.get('size'));
  await expect(page.locator('[data-grid] .check-card-wrap')).toHaveCount(compact);
  expect((await cardIds(page))[0]).toBe(ids[0]);
  expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);
  // Compact thumbnails are the smaller ones.
  await expect(page.locator('[data-grid] img').first()).toHaveAttribute('src', /w=640/);
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollHeight,
    inner: window.innerHeight,
  }));
  expect(scroll).toBeLessThanOrEqual(inner);

  // Remembered: a new visit renders compact cards at once.
  await page.goto(`/ui/builds/${buildId}?filter=all`);
  await expect(page.locator('[data-grid]')).toHaveAttribute('data-density', 'compact');
  await expect(page.getByRole('button', { name: 'Compact' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Large' }).click();
  await expect(page.locator('[data-grid]')).toHaveAttribute('data-density', 'large');
  await expect.poll(() => Number(new URL(page.url()).searchParams.get('size'))).toBe(large);
});

test('a full page shows its top, sharp, and a full page changed lower down the band with its change', async ({
  adminPage: page,
  admin,
}) => {
  const { slug, ci } = await project(admin);
  // A long page: dark bands every 400 px; the change is a red bar 3000 px down.
  const page4000 = (changed: boolean) =>
    makePng(1280, 4000, WHITE, [
      ...Array.from({ length: 10 }, (_, k) => ({ x: 0, y: k * 400, width: 1280, height: 40, color: BLACK })),
      ...(changed
        ? [{ x: 200, y: 3000, width: 600, height: 60, color: [229, 72, 77, 255] as [number, number, number, number] }]
        : []),
    ]) as Uint8Array<ArrayBuffer>;
  const first = await ci.call<{ id: string }>('POST', `/projects/${slug}/builds`, { branch: 'main' });
  await ci.check(first.id, 'long', page4000(false));
  await ci.call('POST', `/builds/${first.id}/approve`);
  await ci.call('POST', `/builds/${first.id}/finalize`);
  const second = await ci.call<{ id: string }>('POST', `/projects/${slug}/builds`, { branch: 'main' });
  const changed = await ci.check(second.id, 'long', page4000(true));
  const fresh = await ci.check(second.id, 'another long', page4000(false));
  await ci.call('POST', `/builds/${second.id}/finalize`);
  await open(page, `/ui/builds/${second.id}?filter=all`);

  // The new one: its top, filling the card's thumbnail as wide as the card.
  const top = page.locator(`[id="${fresh.id}"] .thumb`);
  await expect(top.locator('.thumb-stack')).toHaveClass('thumb-stack part');
  await expect(top.locator('img')).toHaveClass(/is-loaded/);
  expect(await top.locator('img').evaluate((img: HTMLImageElement) => img.currentSrc)).toContain('fit=top');
  await expect(top.locator('.thumb-hint')).toHaveText('Full page ↓');
  const [thumbBox, imgBox] = [await top.boundingBox(), await top.locator('img').boundingBox()];
  expect(imgBox?.width).toBeGreaterThan((thumbBox?.width ?? 0) - 20);

  // The changed one: the band around the change, with the change painted on it.
  const band = page.locator(`[id="${changed.id}"] .thumb`);
  await expect(band.locator('.thumb-stack')).toHaveClass('thumb-stack part at-change');
  await expect(band.locator('.thumb-hint')).toHaveText(/^Change \d+% down/);
  expect(await band.locator('img').evaluate((img: HTMLImageElement) => img.currentSrc)).toMatch(
    /crop=0%2C2\d{3}%2C1280%2C800/,
  );
  await expect(band.locator('canvas.thumb-mask')).toHaveCount(1);
  // The check page still shows the whole screenshot.
  await band.click();
  await expect(page).toHaveURL(new RegExp(`/ui/checks/${changed.id}`));
});

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
  // Whichever thumbnail of it the browser picks from srcset.
  const first = /<img src="[^"]*\/images\/([0-9a-f]{64})\/thumb\?w=960"/.exec(html)?.[1] ?? '';
  expect(first).toHaveLength(64);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/images/*/thumb*', async (route) => {
    if (route.request().url().includes(`/images/${first}/`)) await held;
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
