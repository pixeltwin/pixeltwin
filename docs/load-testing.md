# Load testing

`scripts/load.ts` simulates many CI runs posting screenshots to one pixeltwin at the same time.
It answers one question: does the service hold up when many test runs upload in parallel?

## What a run does

Each simulated CI run:

1. opens a build: `POST /api/v1/projects/{slug}/builds` with `{ branch: "main", commitSha, externalId }`;
2. posts its checks concurrently: `POST /api/v1/builds/{id}/checks`, multipart `image` + `meta`
   (or JSON `imageBase64` with `--json`);
3. finalizes: `POST /api/v1/builds/{id}/finalize`.

The screenshots are page-like 1280×800 PNGs made with pngjs. They have a header, a sidebar, a
gradient hero with a noisy "photo", cards and lines of glyph-like text, and they average about
176 KB each. Each check name has its own content. The first run seeds the baselines and approves
them with `POST /builds/{id}/approve`. Later runs post mostly the same bytes, so those checks come
back `unchanged` without a diff. A share of each run's checks (`--changed`, 10% by default, picked
at random per run) has a changed button and text line, so the diff workers really compare and
encode a diff image. `--reencoded` posts the same pixels with different PNG bytes, which forces a
full diff that ends `unchanged`. This is the worst case for the worker pool.

While the runs upload, `--readers` loops act as reviewers. They read `GET /api/v1/builds/{id}`,
`GET /api/v1/builds/{id}/checks` and the build page `/ui/builds/{id}` (with the session cookie).

## Running it

```sh
bun install
# Start a fresh server from this checkout (temporary DATA_DIR, SQLite), set it up, test, stop it:
BUN_CONFIG_MAX_HTTP_REQUESTS=8192 bun scripts/load.ts --spawn --port 18900 --runs 20 --checks 50

# The same on Postgres (the database must be new and empty, so the server prints a setup token):
BUN_CONFIG_MAX_HTTP_REQUESTS=8192 bun scripts/load.ts --spawn --port 18900 \
  --database-url postgres://postgres:postgres@localhost:55432/pixeltwin_load --runs 50 --checks 20

# Ramp: one wave per level, stop at the knee (check p95 > 5 s or > 1% failed requests):
BUN_CONFIG_MAX_HTTP_REQUESTS=8192 bun scripts/load.ts --spawn --checks 50 \
  --check-concurrency 4 --stagger 3000 --ramp 20,40,80,120,160,240

# Against a server you started yourself:
bun scripts/load.ts --url http://localhost:18900 --setup-token <token from the log>   # fresh server
bun scripts/load.ts --url http://localhost:18900 --token pt_… --cookie pt_session=… --pid <server pid>
```

`BUN_CONFIG_MAX_HTTP_REQUESTS` matters. Bun's `fetch` keeps at most 256 requests in flight by
default and queues the rest inside the client, which hides server behaviour. The script warns
when it is unset.

| Option | Default | Meaning |
| --- | --- | --- |
| `--runs N` | 5 | parallel CI runs |
| `--checks N` | 50 | checks per run |
| `--check-concurrency N` | all | uploads in flight per run (real CI usually has 4–8 workers) |
| `--width`, `--height` | 1280, 800 | screenshot size |
| `--changed F` | 0.1 | share of checks whose pixels differ from the baseline |
| `--reencoded F` | 0 | share with identical pixels but different bytes (full diff) |
| `--ramp L1,L2,…` | – | one wave per level of parallel runs; stops at the knee |
| `--stop-p95-ms`, `--stop-error-rate` | 5000, 0.01 | knee criteria for `--ramp` |
| `--stagger MS` | 0 | spread run starts over this many ms (0 = all at once) |
| `--readers N`, `--reader-interval MS` | 2, 200 | reviewer read loops during load |
| `--json` | off | upload as JSON `imageBase64` instead of multipart |
| `--spawn`, `--port`, `--database-url`, `--diff-workers`, `--keep-data` | – | spawned-server settings |
| `--out FILE` | – | full results as JSON |

For every wave the script prints:

- client-side latency (p50/p95/p99/max) per endpoint;
- checks per second;
- errors grouped by endpoint, HTTP status and problem `code` (status 0 means a connection error);
- the check results (`changed→changed`, `baseline→unchanged`, …);
- a latency histogram;
- wall time per run;
- server RSS and CPU, from `ps` every 500 ms (diff workers are threads, so they are included);
- the load client's own CPU.

With `--spawn` it also scans the server log. It prints server-side request times per route and
counts `SQLITE_BUSY`, `database is locked`, `diff_timeout`, `diff_failed` and warn/error lines.
The gap between client and server times shows where requests wait before the app sees them.

## Results (2026-10-16)

Setup:

- Host: MacBook, 10 cores, 32 GB RAM, macOS 26.7, Bun 1.3.13.
- Server: defaults, so `DIFF_WORKERS` = 10. Commit `99cfcd0`.
- Load client: on the same machine, using 7–24% CPU.
- Postgres 17 in Docker Desktop (`pixeltwin-pg`).
- Noise: the machine was shared with other work, and the load average reached 15–27. Throughput
  for an identical wave varied between 288 and 445 checks/s (see the soak below). Read single
  numbers as ±25%.

### Required scenarios: every check of every run uploads at once (no per-run limit, no stagger)

| DB | Runs × checks | Wall s | Checks/s | Failed | Check p50 / p95 / p99 / max ms | Server-side check p95 ms | Run wall p50 / max s | UI read p95 ms | RSS peak MB | CPU avg / peak % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SQLite | 5 × 50 | 1.1 | 219 | 0 | 453 / 855 / 1105 / 1124 | 620 | 0.9 / 1.1 | 404 | 1532 | 633 / 689 |
| SQLite | 20 × 50 | 7.9 | 117 | **74** | 1877 / 7798 / 7803 / 7803 | 457 | 2.6 / 7.9 | 2290 | 1535 | 249 / 694 |
| SQLite | 50 × 20 | 7.9 | 111 | **120** | 1869 / 7787 / 7796 / 7796 | 656 | 2.7 / 7.9 | 3976 | 1498 | 254 / 730 |
| Postgres | 50 × 20 | 4.3 | 234 | 0 | 3998 / 4135 / 4156 / 4163 | 4133 | 4.3 / 4.3 | 2351 | 1979 | 541 / 696 |

All failures were `POST /checks 0 ConnectionRefused`, raised before the request reached the app.
Server-side, check times stayed under 1.1 s throughout. See "TCP accept backlog" below.

### Ramp A: burst mode on SQLite (all checks at once, 50 per run)

| Runs (uploads in flight) | Checks/s | Failed | Check p50 / p95 / max ms |
| --- | --- | --- | --- |
| 2 (100) | 183 | 0 | 147 / 450 / 536 |
| 4 (200) | 326 | 0 | 148 / 389 / 583 |
| 8 (400) | 434 | 0 | 311 / 634 / 882 |
| 12 (600) | 425 | 0 | 473 / 1177 / 1362 |
| **16 (800)** | 100 | **15 (ConnectionRefused)** | 678 / 5976 / 7795 |

### Ramp B: realistic CI (4 uploads in flight per run, starts spread over 3 s, 50 checks, 10% changed)

| DB | Runs | Checks/s | Failed | Check p50 / p95 / p99 / max ms | Run wall p50 / max s | UI read p95 ms | API read p95 ms | RSS peak MB | CPU avg / peak % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SQLite | 20 | 257 | 0 | 21 / 359 / 512 / 627 | 1.0 / 1.5 | 60 | 91 | 1588 | 552 / 752 |
| SQLite | 40 | 374 | 0 | 87 / 704 / 1023 / 1188 | 2.4 / 3.2 | 109 | 146 | 1774 | 687 / 768 |
| SQLite | 80 | 400 | 0 | 157 / 2523 / 3114 / 3465 | 6.7 / 7.7 | 173 | 307 | 1997 | 713 / 804 |
| SQLite | 120 | 426 | 0 | 249 / 4129 / 5280 / 5573 | 10.3 / 12.1 | 288 | 519 | 2233 | 742 / 842 |
| SQLite | **160** | 416 | 0 | 288 / **6670** / 8262 / 8643 | 15.5 / 17.5 | 371 | 292 | 2348 | 717 / 864 |
| Postgres | 20 | 204 | 0 | 121 / 419 / 621 / 829 | 2.1 / 2.8 | 167 | 99 | 1548 | 442 / 637 |
| Postgres | 40 | 295 | 0 | 271 / 484 / 625 / 767 | 4.0 / 4.5 | 356 | 121 | 1636 | 556 / 663 |
| Postgres | 80 | 324 | 0 | 756 / 1189 / 1331 / 1523 | 10.3 / 10.8 | 672 | 560 | 1843 | 614 / 715 |
| Postgres | 120 | 324 | 0 | 1272 / 1671 / 1905 / 2054 | 16.1 / 16.9 | 1371 | 566 | 1952 | 614 / 743 |
| Postgres | 160 | 333 | 0 | 1695 / 2235 / 2530 / 2757 | 21.8 / 22.4 | 1639 | 871 | 2085 | 625 / 777 |

### Extra experiments

| Experiment | Result |
| --- | --- |
| No changed images (no diffs), SQLite, 120–240 runs × 50, 4 per run | **1010–1017 checks/s** ceiling, server CPU 103–133% (one core: the main thread) |
| No changed images, Postgres, 120 runs × 50 | **684 checks/s** ceiling, CPU 129% |
| Heavy diffs: 10% changed + 50% re-encoded, SQLite, 60 runs × 50 | 457 checks/s (1800 diffs in 6.6 s), CPU avg 846% / peak 919%, p95 1.3 s |
| Soak: 8 identical waves of 60 runs × 50, SQLite | 288–445 checks/s with no downward trend (noise); RSS levels off at 1.85–2.07 GB |
| `DIFF_WORKERS=1`, 40% changed, 20 runs × 50 | 17 checks/s (≈7 diffs/s, 145 ms each); uploads waited up to 12.8 s; no errors, no `diff_timeout`, connections not dropped; reviewer reads p95 3 ms |
| JSON `imageBase64` uploads, 40 runs × 50, SQLite | 238 checks/s vs 374 multipart (one noisy run; base64 decode and JSON parse run on the main thread) |

Across all runs, the server logs showed:

- 0 `SQLITE_BUSY` and 0 `database is locked`;
- 0 `diff_timeout` and 0 `diff_failed`;
- 0 HTTP 5xx and 0 `unhandled error` lines;
- no 4xx except the expected ones.

## Knee

- **Burst (every upload at once):** about 600 simultaneous uploads work (12 × 50: p95 1.2 s,
  425 checks/s). At about 800, connections are refused. That limit is the OS listen queue on this
  Mac, not the app.
- **Sustained, 10% changed:**
  - SQLite throughput levels off at **≈400–430 checks/s** (≈40 diffs/s) from about 40–80
    parallel runs. With 4 uploads per run, check p95 passes 5 s between **120 runs (4.1 s) and
    160 runs (6.7 s)**, that is, about 500–640 uploads in flight. Nothing fails; requests just
    queue.
  - Postgres levels off lower, at **≈325–333 checks/s**, but its latency is even: at 160 runs,
    p50 is 1.7 s and p95 is 2.2 s. By Little's law, p95 would pass 5 s at about 350+ runs.
- **Time per CI run:** a 50-check run finishes in about 1 s when alone, 2.4 s with 40 others, and
  10–16 s with 120 others.

## Bottlenecks, with evidence

1. **Diff worker CPU when images change.**
   - Benchmark of `compareImages` on one quiet core:
     - changed 1280×800 pair: **133 ms**;
     - re-encoded identical pair: **82 ms**;
     - validating a new image: 12 ms.
   - Where the time goes: decoding a PNG takes 13 ms, pixelmatch 8 ms, and encoding the diff PNG
     46 ms (pngjs's default `deflateLevel` is 9). The per-pixel loop in `src/diff/compare.ts`
     that does `diffImage.set(overlapDiff.subarray(o, o + 4), i * 4)` takes **≈47 ms**. Copying
     the same data in bulk takes 1 ms.
   - Under load, `ps -M` showed 10 worker threads at 64–71% each, the main thread at 83%, and
     the process at 720–920% of 1000%. With diffs, throughput is 420 checks/s; without them it is
     1010 checks/s.
2. **The single main thread.** Without diffs, throughput tops out at ≈1010 checks/s (SQLite) or
   ≈684 (Postgres), with the process at 100–130% CPU. All of this runs on the main thread:
   - multipart parsing of a 176 KB body;
   - sha256;
   - about 13 database queries per check: `getBuildRow` twice, the token lookup, project,
     baseline, areas, the image upsert, a 5-statement transaction and a final select;
   - a file write;
   - a JSON log line.
3. **TCP accept backlog (burst only).**
   - `netstat -Lan` showed the listener at `128/…/128`. That is `kern.ipc.somaxconn` = 128 on
     macOS, and `Bun.serve` has no backlog option.
   - Connections beyond the queue are dropped and retried by TCP. The client latency histogram
     has clusters near 1 s, 3 s and 7 s (SYN retransmits) and a gap between 3 and 4 s, and then
     comes `ConnectionRefused`. Meanwhile, server-side p95 stays under 1.1 s.
   - It also slows reviewers: UI read p95 was 2.3–4.0 s on the client, but 4–7 ms on the server.
   - SQLite is hit harder than Postgres. With SQLite, the main thread is busy in synchronous
     queries and accepts less often. Linux defaults to `somaxconn` 4096, so the effect there is
     probably smaller. This was not tested.
4. **The SQLite write lock is not a bottleneck.** `src/db/bun-sqlite-dialect.ts` uses one
   connection behind an in-process mutex. SQLite never sees contention, so `busy_timeout = 5000`
   never applies, and no `SQLITE_BUSY` appeared at up to 1000 checks/s. Reviewer reads stayed
   fast server-side (UI p95 ≤ 28 ms) even during the heaviest waves.
5. **Postgres runs slower per check than SQLite, though the database itself is idle.**
   - `pg_stat_activity` during load showed 10 connections, mostly `idle` or
     `idle in transaction` waiting on `ClientRead` (waiting for the app). There were no `Lock`
     waits.
   - A `select 1` round trip took 0.28 ms, and the pool managed 17.8k queries/s when otherwise
     idle.
   - The cost is in the app process: the async `pg` driver and about 13 round trips per check,
     over a pool fixed at `max: 10` in `src/db/database.ts`.
   - Reviewers feel it: server-side UI read p95 was 1.4–1.6 s at 120–160 runs, because reads
     queue on the same pool and event loop.
6. **No backpressure.** The diff queue in `src/diff/pool.ts` is unbounded, and `DIFF_TIMEOUT_MS`
   starts only when a job is dispatched. Overload therefore shows up as latency, never as errors:
   with one worker, uploads waited 12.8 s and none failed. That is good for correctness. But a CI
   client with a short HTTP timeout fails while the server keeps working on its upload.
7. **Memory.** RSS starts at about 500–650 MB with 10 workers (314 MB with 1). It peaks at
   1.5–2.3 GB under load, levels off at about 2 GB in the soak, and stays there when idle
   (1.96 GB after 20 s idle). There is no growth trend, so this is allocator retention, not a
   leak.
8. **Request body limits were not hit.** The upload limit is `ceil(MAX_IMAGE_BYTES / 3) * 4` +
   64 KiB, about 13.4 MB with the 10 MiB default. 1280×800 screenshots (176 KB, 235 KB as
   base64) are far below it.

## Recommendations

1. **Make diffs cheaper**, in `src/diff/compare.ts`:
   - When the sizes match, use pixelmatch's output buffer as the diff image (or copy it with one
     `set`) instead of a `subarray` per pixel. This saves ≈47 ms of the 82–133 ms per diff.
   - Compare the decoded RGBA buffers (`Buffer.equals`) before pixelmatch, so re-encoded
     identical screenshots end after the decode.
   - Encode diff PNGs with `deflateLevel` 1–3, not pngjs's default 9. Diff images are mostly flat
     grey and compress well at low levels.
2. **Cut main-thread work per check:**
   - drop the duplicate `getBuildRow` (route and `submitCheck`);
   - return the row from the upsert instead of selecting it again;
   - cache project and token lookups for a few seconds;
   - consider `DIFF_WORKERS` = cores − 1, so the main thread keeps a core.
3. **Postgres:** make the pool size configurable (for example `DATABASE_POOL_MAX`, default about
   20). Consider a separate small pool for UI and API reads, so reviewers do not queue behind
   uploads.
4. **Backpressure:** reject uploads with `503` and `Retry-After` (for example a `server_busy`
   problem) when the diff queue is longer than about 20× the worker count, or document that CI
   clients need an upload timeout of 60 s or more.
5. **Client guidance:** have SDKs and the docs cap uploads per run at 4–8 and retry connection
   errors (`ECONNREFUSED`, `ECONNRESET`) with jitter. Never fire a whole suite at once.
6. **Deployment:** on Linux, keep `net.core.somaxconn` ≥ 1024. Budget about 2.5 GB RAM for the
   default 10 workers under heavy load.
7. **Repeat the test** on a quiet Linux host, with the load client on another machine, before
   setting capacity numbers. These results come from a shared laptop.

## Changes after this test (2026-10-16)

Recommendations 1-4 are in:

1. Diffs are cheaper: overlap rows are copied whole, identical pixels (in other PNG bytes) skip
   pixelmatch, and diff PNGs use one fixed filter (pngjs tried all five per row). A changed
   1280×800 pair takes 43 ms instead of 133 ms, a re-encoded identical pair 26 ms instead of 85.
   Diff PNGs are about 5% larger.
2. The upload route reads the build once (it was read twice), and `DIFF_WORKERS` defaults to
   cores − 1.
3. `DATABASE_POOL_MAX` sets the Postgres pool, default 20 (was a fixed 10).
4. Backpressure: while more than `DIFF_QUEUE_MAX` diffs wait (default `DIFF_WORKERS` × 20),
   uploads get `503 server_busy` with `Retry-After`, before the body is read.

Not done: caching project and token lookups (a revoked token must stop working at once) and a
separate read pool for Postgres.
