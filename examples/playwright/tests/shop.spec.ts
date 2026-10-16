import { expect, test } from '@pixeltwin/playwright';

// The clocks (header and footer) differ on every run. Every check ignores them by locator: the
// screenshot keeps them, pixeltwin just never compares those pixels.

test('home, the whole page', async ({ page, pixeltwin }) => {
  await page.goto('/');
  await pixeltwin.check(page, 'home', { fullPage: true, ignore: [page.locator('.clock')] });
});

test('products, the viewport and one card', async ({ page, pixeltwin }) => {
  await page.goto('/products.html');
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  await pixeltwin.check(page, 'products', { ignore: [page.locator('.clock')] });
  // An element screenshot: just the first card.
  await pixeltwin.check(page.locator('.card').first(), 'product card');
});

test('header', async ({ page, pixeltwin }) => {
  await page.goto('/about.html');
  const check = await pixeltwin.check(page.locator('header'), 'header', { ignore: [page.locator('header .clock')] });
  // The check resolves to what pixeltwin compared (null with PIXELTWIN_DISABLED=1). A `changed` or
  // `new` result does not fail the test: the build verdict decides once, at the end of the run.
  expect(check?.result).not.toBe('error');
});

test('about', async ({ page, pixeltwin }) => {
  await page.goto('/about.html');
  await pixeltwin.check(page, 'about', { ignore: [page.locator('.clock')] });
});
