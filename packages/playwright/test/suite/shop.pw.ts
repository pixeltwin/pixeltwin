import { expect, test } from '@pixeltwin/playwright';

// SUITE_CHANGE=1 turns the heading red: a visible change. The clock differs on every run and is
// ignored, so it never shows up as a change.
const heading = process.env.SUITE_CHANGE === '1' ? '#d1242f' : '#222222';
const html = `<!doctype html>
<html><body style="margin:0;font:16px/1.4 sans-serif;background:#fff">
  <header style="height:64px;background:#111;color:#fff;display:flex;align-items:center;gap:24px;padding:0 16px">
    <b>Shop</b>
    <span class="clock" style="display:inline-block;width:150px;overflow:hidden;white-space:nowrap">${Date.now()}-${Math.random()}</span>
  </header>
  <h1 style="margin:24px 16px;color:${heading}">Welcome</h1>
  <button style="margin:0 16px;width:120px;height:36px;background:#0070f3;color:#fff;border:0">Buy</button>
  <div style="height:1200px"></div>
  <footer style="height:48px;background:#eee">Footer <span class="clock" style="display:inline-block;width:150px;overflow:hidden">${Math.random()}</span></footer>
</body></html>`;

test.beforeEach(async ({ page }) => {
  await page.setContent(html);
});

test('home', async ({ page, pixeltwin }) => {
  const check = await pixeltwin.check(page, 'home', { ignore: [page.locator('.clock')] });
  expect(check?.result).not.toBe('error');
});

test('full page', async ({ page, pixeltwin }) => {
  await page.evaluate(() => window.scrollTo(0, 300)); // scrolled: ignore boxes must still land on the clocks
  await pixeltwin.check(page, 'full page', { fullPage: true, ignore: [page.locator('.clock')] });
});

test('header', async ({ page, pixeltwin }) => {
  await pixeltwin.check(page.locator('header'), 'header', { ignore: [page.locator('header .clock')] });
});
