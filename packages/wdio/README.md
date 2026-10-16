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
  await browser.pixeltwinCheck('home', { ignore: [$('.clock')] });
  await $('header').pixeltwinCheck('header');
});
```

`PIXELTWIN_URL` and `PIXELTWIN_TOKEN` (a project token with `read` + `write`) come from the
environment, or pass `url` and `token` in the options. Every option of
[`@pixeltwin/playwright`](../playwright/README.md#configuration) works here too, as a service
option or the same environment variable, plus `variant` (extra variant keys for every check).

How it runs: the launcher's `onPrepare` opens the build and hands its id to the workers;
`onComplete` finalizes it, prints the verdict, the counts and what waits for review, and with the
gate on stops the launcher with exit code 1 unless the verdict is `passed`. A `changed` or `new`
check does not fail its test. With `--shard`, no shard finalizes; run
`npx @pixeltwin/client finalize --gate` after all of them.

## `pixeltwinCheck(name, options?)`

On `browser`: the viewport. On an element: that element. Resolves to the compared check, or
`null` when disabled (`PIXELTWIN_DISABLED=1`).

| Option | |
|---|---|
| `ignore` | elements, `$()` results or `{x, y, width, height}` rectangles in screenshot pixels: never compared |
| `variant` | extra variant keys for this check |
| `colorThreshold`, `tolerancePercent` | override the project's settings for this check |

Every check gets the variant `{ browser: <browserName>, viewport: '<innerWidth>x<innerHeight>' }`.
Ignored elements are measured in the page and scaled to screenshot pixels. Full-page screenshots
are not offered (WebDriver screenshots are of the viewport or an element).
