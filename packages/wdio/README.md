# @pixeltwin/wdio

A [WebdriverIO](https://webdriver.io) service for [pixeltwin](../../README.md): `browser.pixeltwinCheck`
and `element.pixeltwinCheck`, one pixeltwin build per run, a summary with review links at the end
and an optional CI gate.

```sh
npm install -D @pixeltwin/wdio     # WebdriverIO ≥ 8
```

```ts
// wdio.conf.ts
import { PixeltwinService } from '@pixeltwin/wdio';

export const config: WebdriverIO.Config = {
  services: [[PixeltwinService, { project: 'shop', gate: !!process.env.CI }]],
  // …
};
```

```ts
import '@pixeltwin/wdio'; // types for browser.pixeltwinCheck

it('home', async () => {
  await browser.url('/');
  await browser.pixeltwinCheck('home', { ignore: [$$('.clock')] });
  await $('header').pixeltwinCheck('header');
});
```

`PIXELTWIN_URL` and `PIXELTWIN_TOKEN` (a project token with `read` + `write`) come from the
environment, or pass `url` and `token` in the options. Every option of
[`@pixeltwin/playwright`](../playwright/README.md#configuration) works here too, as a service
option or the same environment variable (`retakes`, `failOnChange`, `allowOffline` too), plus:

| Service option | |
|---|---|
| `variant` | extra variant keys for every check, or `(auto, capabilities) => variant` to rename or replace the automatic ones |
| `ignore` | rectangles (screenshot pixels) never compared on any viewport screenshot, or `({ capabilities, width, height }) => rects`: a status bar, a browser toolbar |
| `onResult` | `async ({ name, check, url, timing, images }) => …` after every check: `timing` says how long it took (screenshot, upload, compare, retakes), `images()` loads its expected, actual and diff PNGs, e.g. for Allure or your own report |

How it runs: the launcher's `onPrepare` opens the build and hands its id to the workers;
`onComplete` finalizes it, prints the verdict, the counts and what waits for review, and with the
gate on stops the launcher with exit code 1 unless the verdict is `passed`. A `changed` or `new`
check does not fail its test. With `--shard`, no shard finalizes; run
`npx @pixeltwin/client finalize --gate` after all of them. Several CI jobs, each with its own
launcher, share one build with `PIXELTWIN_PARALLEL_TOTAL` (see
[Parallel CI jobs](../playwright/README.md#parallel-ci-jobs)): the last one to end finalizes it.

## `pixeltwinCheck(name, options?)`

On `browser`: the viewport. On an element: that element. Resolves to the compared check, or
`null` when disabled (`PIXELTWIN_DISABLED=1`).

| Option | |
|---|---|
| `ignore` | elements, `$()` or `$$()` results (every element), CSS selectors (`'.delivery-date'`: every match, found when the screenshot is taken) or `{x, y, width, height}` rectangles in screenshot pixels: never compared |
| `variant` | extra variant keys for this check |
| `colorThreshold`, `tolerancePercent` | override the project's settings for this check |
| `retakes`, `failOnChange` | override the service's settings for this check |

Every check gets the variant `{ browser: <browserName>, viewport: '<innerWidth>x<innerHeight>' }`.
Ignored elements are measured in the page and scaled to screenshot pixels. Full-page screenshots
are not offered (WebDriver screenshots are of the viewport or an element).

A `changed` check is screenshotted again while `retakes` last (a page still loading settles); with
`failOnChange` a check that is not unchanged throws `PixeltwinCheckError`, failing its test there.

## Phones through Appium

On an Appium session (`platformName` iOS or Android), native app or mobile browser, the variant
comes from the capabilities: `{ os: 'iOS 16.0', device: 'iPhone 13 Pro Max' }` (plus `browser` in
a mobile browser).

In a mobile browser, elements and selectors in `ignore` work as on a desktop. The screenshot also
shows the system bars and the browser's own bars, so the service finds where the page starts in it:
once per viewport size, the page shows a thin magenta bar at its top for one screenshot (the
address bar on top or at the bottom, any device). A native app has no page: ignore rectangles in
screenshot pixels there.

The bars themselves change from run to run (the clock, the battery): ignore them for every check
with the service's `ignore`:

```ts
services: [[PixeltwinService, {
  project: 'storefront',
  retakes: 3,
  failOnChange: true,
  // The iOS status bar and the home indicator (and Safari's bottom toolbar), in screenshot pixels.
  ignore: ({ capabilities, width, height }) =>
    capabilities.platformName === 'iOS'
      ? [{ x: 0, y: 0, width, height: 140 }, { x: 0, y: height - 400, width, height: 400 }]
      : [],
}]],
```

A complete project that runs a real Chrome (desktop and an emulated phone) through WebdriverIO's
own driver management, with a demo site and a CI snippet: [`examples/wdio`](../../examples/wdio/README.md).
