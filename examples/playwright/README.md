# pixeltwin with Playwright Test

A small, standalone project that posts screenshots from [Playwright Test](https://playwright.dev)
to a [pixeltwin](../../README.md) server with [`@pixeltwin/playwright`](../../packages/playwright/README.md).
Copy this directory anywhere and it keeps working.

It shows:

- a **full page** check (`home`), viewport checks (`products`, `about`) and **element** checks
  (`header`, `product card`);
- **ignoring the clock** by locator: `ignore: [page.locator('.clock')]`. The clock changes on
  every run; its pixels are never compared;
- **variants per browser and viewport**: three projects (Chromium 1280×800, Firefox 1280×800,
  Chromium on a Pixel 7) give every check three baselines;
- the **CI gate** (`PIXELTWIN_GATE=1`) and **sharding** with `npx pixeltwin finalize --gate`;
- **`DEMO_CHANGE=1`**: the demo site loads a stylesheet that turns the headings red and the
  buttons green, a visible change.

```
playwright.config.ts   globalSetup: '@pixeltwin/playwright/setup', three projects, webServer
tests/shop.spec.ts     the checks
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
npm run sdk:local                 # = bun scripts/build-sdk.ts pack examples/playwright/vendor
npm install
npx playwright install chromium firefox
```

Once the packages are published, replace the two `file:` dependencies in `package.json` and skip
`sdk:local`:

```json
"@pixeltwin/client": "^0.1.0",
"@pixeltwin/playwright": "^0.1.0",
```

(`@pixeltwin/playwright` depends on `@pixeltwin/client` itself; the direct dependency is there
for the `pixeltwin` command.)

## Run

```sh
export PIXELTWIN_URL=http://localhost:8080
export PIXELTWIN_TOKEN=pt_…        # the read + write token
export PIXELTWIN_PROJECT=shop
npx playwright test
```

| Variable | |
|---|---|
| `PIXELTWIN_URL` | the server (default `http://localhost:8080`) |
| `PIXELTWIN_TOKEN` | a project token with `read` and `write`; required |
| `PIXELTWIN_PROJECT` | the project slug; required |
| `PIXELTWIN_GATE=1` | fail the run unless the build's verdict is `passed` |
| `PIXELTWIN_BRANCH` | the branch to post to (default: from CI, else `.git/HEAD`, else the project's main branch) |
| `PIXELTWIN_DISABLED=1` | run the tests, take and post no screenshots |
| `DEMO_CHANGE=1` | this example only: the demo site with a visible change |
| `SITE_PORT` | this example only: the demo site's port (default 19181) |

Every option is in the [`@pixeltwin/playwright` README](../../packages/playwright/README.md#configuration).

## The flow

1. **First run**: no baselines yet, every check is `new`. Without the gate the run passes; the
   summary links to the build.
2. **Approve** the build in the UI (open the review link, then *Approve all*, or <kbd>A</kbd> on
   each check), or with a token that has the `review` scope:
   `curl -X POST -H "authorization: Bearer $REVIEW_TOKEN" $PIXELTWIN_URL/api/v1/builds/<build id>/approve`.
3. **Second run** with `PIXELTWIN_GATE=1`: everything is `unchanged` (the clock changed, but it is
   ignored), the verdict is `passed`, exit code 0.
4. **A change**: `PIXELTWIN_GATE=1 DEMO_CHANGE=1 npx playwright test`. The tests still pass (a
   changed check never fails its own test), but the build waits for review and the gate fails the
   run with exit code 1.

## What you should see

Recorded on 2026-10-16 against a fresh server (`bun scripts/examples.ts playwright` in the
repository root runs exactly this; build and check ids shortened).

Run 1, `npx playwright test` (exit 0):

```
pixeltwin: build #1 on main → http://localhost:19100/ui/builds/bld_01M51S7R…
pixeltwin: build #1 on main: verdict pending
pixeltwin: 15 checks: 0 unchanged, 0 changed, 15 new, 0 errors; 15 awaiting review
pixeltwin:   new       header (chromium, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S7S…
pixeltwin:   new       home (chromium, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S7S…
pixeltwin:   new       about (chromium, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S7S…
pixeltwin:   new       products (chromium, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S7S…
pixeltwin:   new       product card (chromium, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S7S…
pixeltwin:   new       home (chromium, 412x839)  http://localhost:19100/ui/checks/chk_01M51S7T…
  … the same for (chromium, 412x839) and (firefox, 1280x800) …
pixeltwin: review at http://localhost:19100/ui/builds/bld_01M51S7R…
  12 passed (5.3s)
```

Approve: `POST /api/v1/builds/bld_01M51S7R…/approve` → `{"approved":15}`.

Run 2, `PIXELTWIN_GATE=1 npx playwright test` (exit 0):

```
pixeltwin: build #2 on main → http://localhost:19100/ui/builds/bld_01M51S7X…
pixeltwin: build #2 on main: verdict passed
pixeltwin: 15 checks: 15 unchanged, 0 changed, 0 new, 0 errors; 0 awaiting review
pixeltwin: review at http://localhost:19100/ui/builds/bld_01M51S7X…
  12 passed (9.4s)
```

Run 3, `PIXELTWIN_GATE=1 DEMO_CHANGE=1 npx playwright test` (exit 1; `header` has no heading or
button, so its three checks stay unchanged):

```
pixeltwin: build #3 on main → http://localhost:19100/ui/builds/bld_01M51S87…
pixeltwin: build #3 on main: verdict pending
pixeltwin: 15 checks: 3 unchanged, 12 changed, 0 new, 0 errors; 12 awaiting review
pixeltwin:   changed   home (chromium, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S88…
pixeltwin:   changed   about (chromium, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S88…
pixeltwin:   changed   products (chromium, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S88…
pixeltwin:   changed   product card (chromium, 1280x800)  http://localhost:19100/ui/checks/chk_01M51S88…
  … the same four for (chromium, 412x839) and (firefox, 1280x800) …
pixeltwin: review at http://localhost:19100/ui/builds/bld_01M51S87…
PixeltwinGateError: pixeltwin verdict is "pending", not "passed". Review: http://localhost:19100/ui/builds/bld_01M51S87…
    at finishRun (…/node_modules/@pixeltwin/client/dist/run.js:255:15)
    at …/node_modules/@pixeltwin/playwright/dist/setup.js:12:13
  12 passed (23.4s)
```

Sharded, two shards with one `PIXELTWIN_EXTERNAL_ID` and then `npx pixeltwin finalize --gate`:

```
$ npx playwright test --shard=1/2
pixeltwin: build #1 left open for the other shards with 8 checks so far. When every part is done, run `npx pixeltwin finalize` with the same environment.
$ npx playwright test --shard=2/2
pixeltwin: build #1 left open for the other shards with 15 checks so far. When every part is done, run `npx pixeltwin finalize` with the same environment.
$ npx pixeltwin finalize --gate
pixeltwin: build #1 on main: verdict pending
pixeltwin: 15 checks: 0 unchanged, 0 changed, 15 new, 0 errors; 15 awaiting review
…
pixeltwin verdict is "pending", not "passed". Review: http://localhost:19160/ui/builds/bld_01M51S9T…
```

## GitHub Actions

Three shards post to one build (found by the run id, `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`);
no shard finalizes. A last job finalizes the build, prints the summary and fails when the verdict
is not `passed`. The branch, the pull request's base branch and the commit come from GitHub's
variables.

```yaml
name: visual
on: [push, pull_request]

env:
  PIXELTWIN_URL: https://pixeltwin.example.com
  PIXELTWIN_TOKEN: ${{ secrets.PIXELTWIN_TOKEN }}   # read + write
  PIXELTWIN_PROJECT: shop

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium firefox
      - run: npx playwright test --shard=${{ matrix.shard }}/3

  pixeltwin:
    needs: test
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx pixeltwin finalize --gate        # exit 1 unless the verdict is passed
```

Without sharding, one job is enough: `PIXELTWIN_GATE=1 npx playwright test` finalizes and gates
by itself.

Baselines are per machine setup: fonts and anti-aliasing differ between macOS and the Linux
runner, so let CI make the baselines (approve the first CI build) rather than a laptop.
