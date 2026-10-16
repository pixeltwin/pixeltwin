# pixeltwin with WebdriverIO

A small, standalone project that posts screenshots from [WebdriverIO](https://webdriver.io) to a
[pixeltwin](../../README.md) server with [`@pixeltwin/wdio`](../../packages/wdio/README.md). It
runs a real Chrome through WebdriverIO's own driver management: no Selenium server, no driver to
install by hand. Copy this directory anywhere and it keeps working.

It shows:

- **viewport** checks (`browser.pixeltwinCheck`: `home`, `products`, `about`) and **element**
  checks (`$(…).pixeltwinCheck`: `header`, `product card`);
- **ignoring the clock** by selector: `ignore: [$$('.clock')]` (every match) or
  `ignore: [$('header .clock')]`. The clock changes on every run; its pixels are never compared;
- **variants per viewport**: two capabilities, Chrome at 1280×800 and Chrome emulating a phone
  (412×839 at a device pixel ratio of 2.625), give every check two baselines. The browser name is
  part of the variant too, so adding a `firefox` capability adds a third set;
- the **CI gate** (`PIXELTWIN_GATE=1`): the launcher exits 1 unless the verdict is `passed`;
- **`DEMO_CHANGE=1`**: the demo site loads a stylesheet that turns the headings red and the
  buttons green, a visible change.

WebDriver screenshots are of the viewport or of an element; full-page checks are a
[Playwright](../playwright/README.md) feature.

```
wdio.conf.ts           services: [[PixeltwinService, {}]], two Chrome capabilities, the site in onPrepare
test/specs/shop.e2e.ts the checks
serve.mjs              a static server for site/ with no dependencies (DEMO_CHANGE=1 → the change)
site/                  the demo site: three pages, a clock in the header and the footer
```

## Setup

**1. A pixeltwin server.** Any running pixeltwin works. To start one from this repository:

```sh
bun install                       # in the repository root
DATA_DIR=$(mktemp -d) PORT=8080 PUBLIC_URL=http://localhost:8080 bun src/main.ts serve
```

The log prints a setup link: open it and create the first admin.

**2. A project and a token.** In the web UI create a project (Projects → New project), for example
`shop`, and in the project's settings a token with the scopes **`read`** and **`write`**. Over the
API:

```sh
curl -c cookies -X POST http://localhost:8080/api/v1/auth/login -H 'content-type: application/json' \
  -H 'origin: http://localhost:8080' -d '{"email":"you@example.com","password":"at least 10 characters"}'
curl -b cookies -H 'origin: http://localhost:8080' -H 'content-type: application/json' \
  -X POST http://localhost:8080/api/v1/projects -d '{"slug":"shop","name":"Shop"}'
curl -b cookies -H 'origin: http://localhost:8080' -H 'content-type: application/json' \
  -X POST http://localhost:8080/api/v1/projects/shop/tokens -d '{"name":"CI","scopes":["read","write"]}'
```

**3. Install.** The packages are not on npm yet. Inside this repository, build them as tarballs
into `vendor/` (needs [Bun](https://bun.sh)); `package.json` points at those files:

```sh
npm run sdk:local                 # = bun scripts/build-sdk.ts pack examples/wdio/vendor
npm install
```

Once the packages are published, replace the two `file:` dependencies in `package.json` and skip
`sdk:local`:

```json
"@pixeltwin/client": "^0.1.0",
"@pixeltwin/wdio": "^0.1.0",
```

(`@pixeltwin/wdio` depends on `@pixeltwin/client` itself; the direct dependency is there for the
`pixeltwin` command.)

The first run needs a network connection: WebdriverIO uses the installed Chrome (or downloads
Chrome for Testing) and downloads the matching chromedriver.

## Run

```sh
export PIXELTWIN_URL=http://localhost:8080
export PIXELTWIN_TOKEN=pt_…        # the read + write token
export PIXELTWIN_PROJECT=shop
npm test                           # = wdio run wdio.conf.ts
```

| Variable | |
|---|---|
| `PIXELTWIN_URL` | the server (default `http://localhost:8080`) |
| `PIXELTWIN_TOKEN` | a project token with `read` and `write`; required |
| `PIXELTWIN_PROJECT` | the project slug; required |
| `PIXELTWIN_GATE=1` | exit 1 unless the build's verdict is `passed` |
| `PIXELTWIN_BRANCH` | the branch to post to (default: from CI, else `.git/HEAD`, else the project's main branch) |
| `PIXELTWIN_DISABLED=1` | run the tests, take and post no screenshots |
| `DEMO_CHANGE=1` | this example only: the demo site with a visible change |
| `SITE_PORT` | this example only: the demo site's port (default 19182) |
| `HEADED=1` | this example only: show the browser windows |

The same settings work as service options: `services: [[PixeltwinService, { project: 'shop',
gate: !!process.env.CI }]]` (options win over the environment). All of them are in the
[`@pixeltwin/wdio` README](../../packages/wdio/README.md).

## The flow

1. **First run**: no baselines yet, every check is `new`. Without the gate the run passes; the
   summary links to the build.
2. **Approve** the build in the UI (open the review link, then *Approve all*, or <kbd>A</kbd> on
   each check), or with a token that has the `review` scope:
   `curl -X POST -H "authorization: Bearer $REVIEW_TOKEN" $PIXELTWIN_URL/api/v1/builds/<build id>/approve`.
3. **Second run** with `PIXELTWIN_GATE=1`: everything is `unchanged` (the clock changed, but it is
   ignored), the verdict is `passed`, exit code 0.
4. **A change**: `PIXELTWIN_GATE=1 DEMO_CHANGE=1 npm test`. The specs still pass (a changed check
   never fails its own test), but the build waits for review and the launcher exits 1 with a
   `SevereServiceError`.

## What you should see

Recorded on 2026-10-16 with WebdriverIO 10.0.2 and Chrome 155 against a fresh server
(`bun scripts/examples.ts wdio` in the repository root runs exactly this; build and check ids
shortened).

Run 1, `npm test` (exit 0):

```
pixeltwin: build #1 on main → http://localhost:19100/ui/builds/bld_01M51S90…
[0-0] PASSED in chrome - file:///test/specs/shop.e2e.ts
[1-0] PASSED in chrome - file:///test/specs/shop.e2e.ts
Spec Files:	 2 passed, 2 total (100% completed) in 00:00:03
pixeltwin: build #1 on main: verdict pending
pixeltwin: 10 checks: 0 unchanged, 0 changed, 10 new, 0 errors; 10 awaiting review
pixeltwin:   new       home (chrome, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S93…
pixeltwin:   new       home (chrome, 412x839)  http://localhost:19100/ui/checks/chk_01M51S93…
pixeltwin:   new       products (chrome, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S94…
pixeltwin:   new       products (chrome, 412x839)  http://localhost:19100/ui/checks/chk_01M51S94…
pixeltwin:   new       product card (chrome, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S94…
pixeltwin:   new       product card (chrome, 412x839)  http://localhost:19100/ui/checks/chk_01M51S94…
pixeltwin:   new       header (chrome, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S94…
pixeltwin:   new       header (chrome, 412x839)  http://localhost:19100/ui/checks/chk_01M51S94…
pixeltwin:   new       about (chrome, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S94…
pixeltwin:   new       about (chrome, 412x839)  http://localhost:19100/ui/checks/chk_01M51S94…
pixeltwin: review at http://localhost:19100/ui/builds/bld_01M51S90…
```

Approve: `POST /api/v1/builds/bld_01M51S90…/approve` → `{"approved":10}`.

Run 2, `PIXELTWIN_GATE=1 npm test` (exit 0):

```
pixeltwin: build #2 on main → http://localhost:19100/ui/builds/bld_01M51S95…
[0-0] PASSED in chrome - file:///test/specs/shop.e2e.ts
[1-0] PASSED in chrome - file:///test/specs/shop.e2e.ts
Spec Files:	 2 passed, 2 total (100% completed) in 00:00:02
pixeltwin: build #2 on main: verdict passed
pixeltwin: 10 checks: 10 unchanged, 0 changed, 0 new, 0 errors; 0 awaiting review
pixeltwin: review at http://localhost:19100/ui/builds/bld_01M51S95…
```

Run 3, `PIXELTWIN_GATE=1 DEMO_CHANGE=1 npm test` (exit 1; `header` has no heading or button, so
its two checks stay unchanged):

```
pixeltwin: build #3 on main → http://localhost:19100/ui/builds/bld_01M51S99…
[0-0] PASSED in chrome - file:///test/specs/shop.e2e.ts
[1-0] PASSED in chrome - file:///test/specs/shop.e2e.ts
Spec Files:	 2 passed, 2 total (100% completed) in 00:00:02
pixeltwin: build #3 on main: verdict pending
pixeltwin: 10 checks: 2 unchanged, 8 changed, 0 new, 0 errors; 8 awaiting review
pixeltwin:   changed   home (chrome, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S9B…
pixeltwin:   changed   home (chrome, 412x839)  http://localhost:19100/ui/checks/chk_01M51S9B…
pixeltwin:   changed   products (chrome, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S9B…
pixeltwin:   changed   product card (chrome, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S9B…
pixeltwin:   changed   products (chrome, 412x839)  http://localhost:19100/ui/checks/chk_01M51S9B…
pixeltwin:   changed   product card (chrome, 412x839)  http://localhost:19100/ui/checks/chk_01M51S9B…
pixeltwin:   changed   about (chrome, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S9B…
pixeltwin:   changed   about (chrome, 412x839)  http://localhost:19100/ui/checks/chk_01M51S9C…
pixeltwin: review at http://localhost:19100/ui/builds/bld_01M51S99…
HookError [SevereServiceError]:
A service failed in the 'onComplete' hook
SevereServiceError: pixeltwin verdict is "pending", not "passed". Review: http://localhost:19100/ui/builds/bld_01M51S99…
    at PixeltwinService.onComplete (…/node_modules/@pixeltwin/wdio/dist/index.js:84:19)
    …
```

## GitHub Actions

```yaml
name: visual
on: [push, pull_request]

jobs:
  wdio:
    runs-on: ubuntu-latest
    env:
      PIXELTWIN_URL: https://pixeltwin.example.com
      PIXELTWIN_TOKEN: ${{ secrets.PIXELTWIN_TOKEN }}   # read + write
      PIXELTWIN_PROJECT: shop
      PIXELTWIN_GATE: 1                                  # exit 1 unless the verdict is passed
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm test
```

The runner has Chrome installed; WebdriverIO fetches the matching chromedriver. The branch, the pull
request's base branch and the commit come from GitHub's variables. To split a long suite over
several jobs, run `npx wdio run wdio.conf.ts --shard ${{ matrix.shard }}/3` in a matrix (WebdriverIO shards by spec file): every
shard posts to one build (found by the run id) and none finalizes, so add a job after them that
runs `npx pixeltwin finalize --gate`, as in the [Playwright example](../playwright/README.md#github-actions).

Baselines are per machine setup: fonts and anti-aliasing differ between macOS and the Linux
runner, so let CI make the baselines (approve the first CI build) rather than a laptop.
