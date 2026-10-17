# @pixeltwin/client

A framework-free client for [pixeltwin](../../README.md). No dependencies: it needs only the
platform `fetch` (Node ≥ 18, Bun, Deno, browsers). For Playwright Test and WebdriverIO use
[`@pixeltwin/playwright`](../playwright/README.md) and [`@pixeltwin/wdio`](../wdio/README.md),
which build on it.

```ts
import { PixeltwinClient, PixeltwinError } from '@pixeltwin/client';

const pixeltwin = new PixeltwinClient({ url: 'https://pixeltwin.example.com', token: process.env.PIXELTWIN_TOKEN! });

const build = await pixeltwin.openBuild('shop', { branch: 'feature/login', externalId: 'ci-run-123' });
const check = await pixeltwin.postCheck(build.id, {
  name: 'home',
  image: pngBytes,                                   // Uint8Array
  variant: { browser: 'chromium', viewport: '1280x800' },
  ignoreRegions: [{ x: 0, y: 0, width: 1280, height: 64 }],
});
console.log(check.result, pixeltwin.checkUrl(check)); // unchanged | changed | new | error

const done = await pixeltwin.finalize(build.id);
if (done.verdict !== 'passed') process.exitCode = 1;  // empty | error | rejected | pending | passed
```

| Method | |
|---|---|
| `openBuild(project, { branch?, baseBranch?, commitSha?, externalId?, parallelTotal? })` | the same `externalId` returns the same build (`created: false`); one is generated when missing. `parallelTotal`: that many parts (CI jobs) finalize it |
| `postCheck(buildId, { name, image, variant?, ignoreRegions?, colorThreshold?, tolerancePercent? })` | answers after the comparison; the same name + variant again replaces the check |
| `getBuild(id)`, `listChecks(buildId, { result?, review?, limit?, cursor? })` | |
| `finalize(buildId, { part? })` | idempotent; a part of a parallel build is counted once, and the build stays open until every part has finalized it |
| `waitForVerdict(buildId, { timeoutMs, intervalMs? })` | polls while the verdict is `pending` |
| `approveBuild(buildId)` | needs the `review` scope |
| `promotionCandidates(project, branch)` | the branch's screens whose baseline differs from main's |
| `promote(project, branch, snapshotKeys?)` | copies them to main, all or some; needs the `write` scope |
| `buildUrl(id)`, `checkUrl(check)` | links into the web UI |
| `fetchImage(check.links.image \| .baseline \| .diff)` | a check's image as PNG bytes, with the client's token |
| `addTimings(buildId, { checks, screenshotMs, uploadMs, retakes })` | adds what one worker measured to the build's `timing` (it also sums each check's server `compareMs`) |

`postWithRetakes(post, { retakes, intervalMs, deadline? })` posts a screenshot and, while it comes
back `changed`, waits and posts a fresh one (`post` must take a new screenshot each time; the same
name and variant replace the check, so the build keeps one). `PixeltwinCheckError` is what the
integrations throw with `failOnChange`: it carries the `check` and its review `url`.

**Timing.** The integrations time every check (`CheckTimer`: screenshot, upload, the server's
`compareMs`, retakes), log one line per check, and send each worker's totals (`TimingTotals`) to the
build; the run's summary then says how long pixeltwin took and where.

**Errors.** The server's problem responses become `PixeltwinError` with `status`, `code` (branch
on it: `build_finalized`, `invalid_image`, `validation_failed`, …), `detail`, `errors` (field errors)
and `requestId`. No answer after the retries is a `PixeltwinNetworkError`.

**Retries.** Network errors, timeouts (60 s per attempt), 408, 429 and 5xx are retried 3 times with
exponential backoff from 500 ms; `Retry-After` is honoured. Options: `retries`, `retryDelayMs`,
`timeoutMs`, `fetch`.

## `pixeltwin finalize`

The CI step after a sharded run (see [`@pixeltwin/playwright`](../playwright/README.md#sharding)):

```sh
npx @pixeltwin/client finalize [--gate] [--wait <seconds>] [--build <id>]
```

It finds the build the shards posted to (by `PIXELTWIN_BUILD_ID`, `PIXELTWIN_EXTERNAL_ID` or the CI
run id), finalizes it, prints the summary and exits 1 when gated and the verdict is not `passed`.

## `pixeltwin promote`

The CI step after merging a branch: its approved baselines become the main branch's, so main does
not ask to review the same screens again. Main builds still waiting on those screens become
`outdated`.

```sh
npx @pixeltwin/client promote feature/login              # every screen that differs from main
npx @pixeltwin/client promote feature/login --dry-run    # list them
npx @pixeltwin/client promote feature/login --only <snapshot key> --only <snapshot key>
```

Admins can do the same in the web UI: Promote on the branch's lane, with a checkbox per screen.

`@pixeltwin/client/run` exports the run lifecycle the integrations share (`resolveSettings`,
`startRun`, `finishRun`, `summaryLines`), for wiring pixeltwin into another runner.
