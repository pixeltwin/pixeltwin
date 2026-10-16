# @pixeltwin/playwright

Visual regression checks for [Playwright Test](https://playwright.dev) with
[pixeltwin](../../README.md): one fixture call per screenshot, one pixeltwin build per test run,
a summary with review links at the end and an optional CI gate.

```sh
npm install -D @pixeltwin/playwright     # Playwright Test ≥ 1.49
```

## Use

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  globalSetup: '@pixeltwin/playwright/setup',
  // …your projects, as before
});
```

```ts
// tests/home.spec.ts
import { test } from '@pixeltwin/playwright';

test('home', async ({ page, pixeltwin }) => {
  await page.goto('https://shop.example.com/');
  await pixeltwin.check(page, 'home', { ignore: [page.locator('.clock')] });
  await pixeltwin.check(page.locator('header'), 'header');
  await pixeltwin.check(page, 'home, whole page', { fullPage: true });
});
```

```sh
export PIXELTWIN_URL=https://pixeltwin.example.com
export PIXELTWIN_TOKEN=pt_…        # project token with read + write
export PIXELTWIN_PROJECT=shop      # project slug
npx playwright test
```

```
pixeltwin: build #12 on feature/login → https://pixeltwin.example.com/ui/builds/bld_…
  ✓  1 [desktop] › home.spec.ts:3:1 › home (1.1s)
pixeltwin: build #12 on feature/login: verdict pending
pixeltwin: 3 checks: 2 unchanged, 1 changed, 0 new, 0 errors; 1 awaiting review
pixeltwin:   changed   home (chromium, 1280x800)  https://pixeltwin.example.com/ui/checks/chk_…
pixeltwin: review at https://pixeltwin.example.com/ui/builds/bld_…
```

In CI add `PIXELTWIN_GATE=1`: the run fails unless the verdict is `passed`. A `changed` or `new`
check never fails its own test; the verdict decides once, at the end.

Already have a custom `test`? Combine them: `export const test = mergeTests(yourTest, pixeltwinTest)`
with `import { test as pixeltwinTest } from '@pixeltwin/playwright'`. Already have a
`globalSetup`? Use an array: `globalSetup: ['./my-setup.ts', '@pixeltwin/playwright/setup']`.

## `pixeltwin.check(target, name, options?)`

`target` is a `Page` (the viewport, or the whole page with `fullPage`) or a `Locator` (that
element). Resolves to the compared check (`result`: `unchanged | changed | new | error`, `diff`,
`links`), or `null` when pixeltwin is disabled. The result and its review link are attached to
the test and added as a `pixeltwin` annotation (visible in the HTML report).

| Option | |
|---|---|
| `ignore` | `(Locator \| {x, y, width, height})[]`: never compared. Every visible element a locator matches counts. Rectangles are screenshot pixels. |
| `mask` | `Locator[]`: Playwright's own masking, painted into the screenshot |
| `fullPage` | the whole scrollable page (page targets) |
| `variant` | extra variant keys for this check |
| `colorThreshold`, `tolerancePercent` | override the project's settings for this check |
| `screenshot` | other Playwright screenshot options (`animations` defaults to `disabled`, `caret` to `hide`) |

**Variants.** The same name in another browser or viewport is another snapshot with its own
baseline: every check gets `{ browser: 'chromium', viewport: '1280x800' }`. Add keys per project
with the `pixeltwinVariant` option: `use: { pixeltwinVariant: { theme: 'dark' } }`.

`pixeltwin.client` (a `PixeltwinClient` from `@pixeltwin/client`) and `pixeltwin.buildId` are there
for anything else.

## Configuration

Environment variables, or options in code with `withPixeltwin` (code wins):

```ts
import { withPixeltwin } from '@pixeltwin/playwright/config';
export default withPixeltwin(defineConfig({ /* … */ }), { project: 'shop', gate: !!process.env.CI });
```

| Variable | Option | Default |
|---|---|---|
| `PIXELTWIN_URL` | `url` | `http://localhost:8080` |
| `PIXELTWIN_TOKEN` | `token` | required |
| `PIXELTWIN_PROJECT` | `project` | required |
| `PIXELTWIN_BRANCH` | `branch` | CI branch (GitHub Actions, GitLab CI), else `.git/HEAD`, else the project's main branch |
| `PIXELTWIN_BASE_BRANCH` | `baseBranch` | the pull/merge request's target, else the project's main branch |
| `PIXELTWIN_COMMIT_SHA` | `commitSha` | from CI |
| `PIXELTWIN_GATE=1` | `gate` | off |
| `PIXELTWIN_WAIT` | `waitSeconds` | `0`; seconds to wait for reviews while the verdict is `pending` |
| `PIXELTWIN_EXTERNAL_ID` | `externalId` | see Sharding |
| `PIXELTWIN_FINALIZE=0` | `finalize` | on (off for a shard) |
| `PIXELTWIN_DISABLED=1` | `disabled` | off; checks take no screenshot and return `null` |

Requests are retried (network errors, timeouts, 429, 5xx) with backoff; errors from the server are
`PixeltwinError` with a stable `code`.

## Sharding

`--shard=1/3` on several machines: every shard posts to the same build (found by the CI run id on
GitHub Actions and GitLab CI, or by `PIXELTWIN_EXTERNAL_ID`) and none of them finalizes. Add a
step after all shards:

```yaml
  pixeltwin:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: npx -y @pixeltwin/client finalize --gate
        env: { PIXELTWIN_URL: …, PIXELTWIN_TOKEN: …, PIXELTWIN_PROJECT: shop }
```

## Example

A complete project with a demo site, three browser/viewport projects, the gate and a sharded
GitHub Actions workflow: [`examples/playwright`](../../examples/playwright/README.md).
