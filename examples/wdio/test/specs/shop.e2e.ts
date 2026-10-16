import '@pixeltwin/wdio'; // types for browser.pixeltwinCheck and element.pixeltwinCheck
import { $, $$, browser, expect } from '@wdio/globals';

// The clocks (header and footer) differ on every run. Every check ignores them by selector: the
// screenshot keeps them, pixeltwin just never compares those pixels.

describe('Pixel Shop', () => {
  it('home', async () => {
    await browser.url('/');
    await browser.pixeltwinCheck('home', { ignore: [$$('.clock')] });
  });

  it('products, the viewport and one card', async () => {
    await browser.url('/products.html');
    await expect($('h1')).toHaveText('Products');
    await browser.pixeltwinCheck('products', { ignore: [$$('.clock')] });
    // An element screenshot: just the first card. ($('.card') would match three: WebdriverIO 10
    // selectors are strict.)
    await $('.card:first-child').pixeltwinCheck('product card');
  });

  it('header', async () => {
    await browser.url('/about.html');
    const check = await $('header').pixeltwinCheck('header', { ignore: [$('header .clock')] });
    // The check resolves to what pixeltwin compared (null with PIXELTWIN_DISABLED=1). A `changed`
    // or `new` result does not fail the test: the build verdict decides once, at the end of the run.
    expect(check?.result).not.toBe('error');
  });

  it('about', async () => {
    await browser.url('/about.html');
    await browser.pixeltwinCheck('about', { ignore: [$$('.clock')] });
  });
});
