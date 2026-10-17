# pixeltwin

Self-hosted visual regression testing with an API built for CI and AI agents.

> Status: early development (0.x).

![Branches of a project: main passed, a feature branch waiting for review](docs/screenshots/branches-light.png)

Review a build with the keyboard: Side, Slider, Onion and Diff views, zoom to a changed region,
<kbd>A</kbd> approve, <kbd>R</kbd> reject (it asks why: <kbd>1</kbd>–<kbd>7</kbd> pick the reason, a comment, <kbd>Enter</kbd>;
<kbd>Shift</kbd>+<kbd>R</kbd> rejects without one), <kbd>U</kbd> undo, <kbd>→</kbd>/<kbd>←</kbd> (or <kbd>J</kbd>/<kbd>K</kbd>)
next and previous, <kbd>?</kbd> for every shortcut. The build page shows a page of cards that fits
the window (no scrolling on a desktop): <kbd>[</kbd>/<kbd>]</kbd> change the page, <kbd>J</kbd>/<kbd>K</kbd> and the
arrows move between cards and across pages, and thumbnails are small copies made on the server.

The same change on many screens is reviewed once: checks of a build with exactly the same changes
(a new header on 40 pages and 3 browsers) form a change group, shown as one card with Approve all
and Reject all (<kbd>A</kbd>/<kbd>R</kbd> on the focused card, <kbd>U</kbd> to undo). Screens that keep
flipping back and forth (a clock, an ad) are marked flaky and listed under Noisy screens; on the
check, Ignore noisy area previews the area that keeps changing and ignores it.

![Reviewing a changed check in the slider view, dark theme](docs/screenshots/review-slider-dark.png)

## Run it

**Docker** (images for amd64 and arm64 are published by the release workflow to
`ghcr.io/pixeltwin/pixeltwin`):

```sh
docker run -d --name pixeltwin -p 8080:8080 -v pixeltwin-data:/data \
  -e PUBLIC_URL=http://localhost:8080 ghcr.io/pixeltwin/pixeltwin:latest
docker logs pixeltwin          # shows the setup link
```

The container runs as uid 65532 (distroless `nonroot`). A named volume works as is; a bind-mounted
directory must be writable by that user, for example `sudo chown -R 65532:65532 ./pixeltwin-data`.

**Docker Compose with Postgres** ([`deploy/docker-compose.postgres.yml`](deploy/docker-compose.postgres.yml)).
With `STORAGE=postgres` the screenshots live in the database too, so the container keeps no state
and one `pg_dump` is the whole backup:

```yaml
# pixeltwin with Postgres. With STORAGE=postgres the database holds everything (screenshots too),
# so pixeltwin keeps no state of its own and one pg_dump is the whole backup.
# Set POSTGRES_PASSWORD (and PUBLIC_URL to the address people open) before the first start.
services:
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: pixeltwin
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
      POSTGRES_DB: pixeltwin
    volumes:
      - pixeltwin-db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pixeltwin -d pixeltwin"]
      interval: 5s
      timeout: 5s
      retries: 20

  pixeltwin:
    image: ${PIXELTWIN_IMAGE:-ghcr.io/pixeltwin/pixeltwin:latest}
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      PUBLIC_URL: ${PUBLIC_URL:-http://localhost:8080}
      DATABASE_URL: postgres://pixeltwin:${POSTGRES_PASSWORD}@db:5432/pixeltwin
      STORAGE: postgres
    ports:
      - "${PIXELTWIN_PORT:-8080}:8080"

volumes:
  pixeltwin-db:
```

```sh
export POSTGRES_PASSWORD='a long random password' PUBLIC_URL=https://pixeltwin.example.com
docker compose -f deploy/docker-compose.postgres.yml up -d
docker compose -f deploy/docker-compose.postgres.yml logs pixeltwin      # shows the setup link
docker compose -f deploy/docker-compose.postgres.yml exec -T db \
  pg_dump -U pixeltwin pixeltwin > pixeltwin-backup.sql                    # backup
```

Postgres is also the way to run several replicas: see [Kubernetes](#kubernetes).

**Binary**: download `pixeltwin-<version>-<os>-<arch>` from the GitHub release (check it against
`SHA256SUMS`), then:

```sh
chmod +x pixeltwin-*-linux-x64
./pixeltwin-*-linux-x64 serve  # http://localhost:8080, data in ./data (SQLite + images)
```

The binaries are not signed. On macOS, clear the download quarantine before the first run:
`xattr -d com.apple.quarantine pixeltwin-*-darwin-*`. x64 binaries are built for any x86-64 CPU
(Bun's baseline target, no AVX2 needed).

**From source**: requires [Bun](https://bun.sh) (version in `.bun-version`).

```sh
bun install
bun src/main.ts serve
```

On first start the log prints a setup link (`setupUrl`). Open it to create the first admin in the
browser; then review screenshots at http://localhost:8080/ui. Or use the API with the setup token:

```sh
curl -X POST http://localhost:8080/api/v1/setup -H 'content-type: application/json' \
  -d '{"token":"<setup token>","email":"you@example.com","password":"at least 10 characters"}'
```

Admins create projects, users and CI tokens in the UI (project maintainers manage tokens too). Over the API it looks like this (reference at `/docs`):

```sh
curl -c cookies -X POST http://localhost:8080/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"at least 10 characters"}'
curl -b cookies -H 'origin: http://localhost:8080' -H 'content-type: application/json' \
  -X POST http://localhost:8080/api/v1/projects -d '{"slug":"web","name":"Web"}'   # slug optional: made from the name
curl -b cookies -H 'origin: http://localhost:8080' -H 'content-type: application/json' \
  -X POST http://localhost:8080/api/v1/projects/web/tokens -d '{"name":"CI","scopes":["read","write"]}'
```

The workflow for CI and agents is in `/llms.txt`; the full contract is `/openapi.json`.

### Users, roles and projects

Each user has a server role, and every non-admin user sees only the projects they can open:

- **Admins** manage the server: every project, users, creating and deleting projects.
- **Members** of a project (Settings → Members, or `POST /api/v1/projects/{slug}/members`) have a
  role there: `viewer` looks (also flaky and noisy screens, review history), `reviewer` also
  approves, rejects, draws areas, reviews change groups and accepts or dismisses agents'
  suggestions, `maintainer` also changes the project's settings (agent review policy included),
  tokens, members, pull request integration and webhooks (but cannot delete the project).
- A project can be **visible to everyone on this server** (a setting, off for new projects): then
  every user opens it with their server role, `viewer` or `reviewer`. A membership can give more.

**Inviting.** Instead of creating users with a password, invite them by email: Settings → Members
→ Invite by email (admins and the project's maintainers), or Users → Invite user (admins, with a
server role and an optional project). An email that already has an account just becomes a member.
Anyone else gets a one-time link (7 days; inviting again or Resend replaces it; Revoke ends it)
where they choose a password and land in the project. With `SMTP_URL` and `SMTP_FROM` set the link
is also mailed; without them it is shown once to copy. Admins get a one-time **reset link** (1 hour)
for any user under Users (the `admin reset-password` command still works too). Links are never
logged and their pages send no Referer. Mail waits in the database (sealed with `SECRET_KEY` when
set, cleared once sent) and is sent in the background like webhook deliveries: a failing SMTP
server never fails the invite, a temporary failure is retried for about an hour and a half, and
with several replicas each mail goes out once.

**Sign-up with approval.** Users → Sign-up turns on "Request access" on the login page (optionally
only for some email domains). Anyone may then ask, with a note; the answer never says whether the
email already has an account. With SMTP they first confirm their email by a link, and admins get a
mail (at most one per 15 minutes, across replicas); without SMTP the request comes marked "email not verified". Until
an admin approves it (with a server role and projects) or turns it down (with a reason), the person
can log in but sees only a waiting page, and the API answers `403 account_pending`. Turned-down
requests are removed after 30 days, never confirmed ones after 7.

The server role of a non-admin is also their default role when they are added to a project. A user
outside a project gets 404 for it and everything in it, as if it did not exist. Project tokens are
unchanged: each one belongs to one project. Upgrading keeps everyone's access: every existing
non-admin user becomes a member of every existing project with their role.

Other commands: `migrate`, `admin reset-password <email>`, and `healthcheck` (exit 0 when the server
on `PORT` answers; the Docker image uses it).

Builds older than a project's retention period (5 days by default, set per project; baselines are always kept) and images
nothing references any more are deleted by an hourly job.

Change groups: every changed region gets a fingerprint of what changed (its changed pixels before
and after, wherever it is on the screen), and a check's change key is the set of its fingerprints.
Checks of one build with the same key form a group (`groupId` on each check,
`GET /api/v1/builds/{id}/groups`, `POST …/groups/{groupId}/approve|reject|reset`); a check with one
more change of its own is not in the group. Flaky screens are found from each screen's last 20
checks on its branch: a screenshot that comes back after a change (A→B→A), or a change nobody
approved that goes away by itself, is a flip, and two flips make the screen flaky
(`GET /api/v1/checks/{id}/history`, `GET /api/v1/projects/{slug}/noisy-screens`).

A project can approve new screenshots automatically (Settings, or `"autoApproveNew": true` on
`PATCH /api/v1/projects/{slug}`): a screen with no baseline yet becomes one as soon as it arrives,
recorded in its review history as approved by auto-approve, and only changes wait for review.

Agents review too. A token with the `review` scope approves and rejects with a reason
(`{"reason": "…"}`), kept in the review history with an "agent" badge. The project's agent review
policy (Settings, or `"agentReview"` on `PATCH /api/v1/projects/{slug}`) decides what that does:
`off` (default: it applies), `suggest` (it becomes a suggestion with the agent's reason; the check
waits until a person clicks Accept or Dismiss) or `auto-below` (approvals of a diff up to
`agentMaxDiffPercent` apply, larger ones become suggestions). Unless `off`, a token must give a
reason and cannot change areas. A suggestion changes neither the pull request's
status nor the build's verdict and sends no `check.reviewed`; accepting it does, as the person's
review with the agent's reason. A change group reviewed by a token goes through the policy check by
check: the answer lists what applied (`changed`) and what became a suggestion (`suggested`).

### Pull requests: GitHub and GitLab

A project can report every build on its pull (merge) request. In **Settings → Pull requests**
(or `PATCH /api/v1/projects/{slug}/integration`; admins and the project's maintainers) pick GitHub
or GitLab and give it a token:

- **GitHub**: a fine-grained personal access token with *Commit statuses* and *Pull requests*
  (read and write) on the repository, or a GitHub App installation token. For GitHub Enterprise
  Server set the API URL to `https://<host>/api/v3`.
- **GitLab**: a project access token with the `api` scope and at least the Developer role. For a
  self-hosted GitLab set the instance URL, e.g. `https://gitlab.example.com`.

Then each finalized build gets a commit status `pixeltwin/<project>`: *pending* "3 screenshots to
review" while changes wait, *success* when the verdict is `passed`, *failure* when something was
rejected or could not be compared. It is posted again whenever a review changes the build (approve,
reject, undo, a change group's Approve all, an area, auto-approve, a promotion; once per action,
however many checks it reviewed), so approving in pixeltwin turns the pull request
green without running CI again. With *Pull request comment* each build keeps one comment (GitLab: a
merge request note) with its counts and up to six changed screens linking to their review pages,
edited in place. The token is never shown again; the API returns `tokenSet` and `tokenLast4`.
Changing the API (instance) URL needs the token again, so a saved token is never sent to a new host.

The SDK sends the commit, repository and pull request from GitHub Actions and GitLab CI by itself
(on GitHub `pull_request` runs, the pull request's head commit, not the merge commit). Without the
SDK, send `commitSha`, `repository` and `pullRequest` when opening the build.

**Promote on merge.** Turn on *Promote on merge*, set a webhook secret (`openssl rand -hex 32`),
and add a webhook on the code host that points at the URL the settings page shows:

- GitHub: repository *Settings → Webhooks → Add webhook*: payload URL
  `<PUBLIC_URL>/api/v1/integrations/github/webhook`, content type `application/json`, the secret,
  *Let me select individual events → Pull requests*.
- GitLab: project *Settings → Webhooks*: URL `<PUBLIC_URL>/api/v1/integrations/gitlab/webhook`,
  the secret as *Secret token*, trigger *Merge request events*.

A merged pull request then promotes its branch's baselines into the branch it was merged into (as
`pixeltwin promote` does), once: a redelivered event changes nothing. The promoted baselines name
the merge as their approver ("GitHub merge by octocat"). The project is found by the repository in
the settings (GitHub `owner/name`, GitLab `group/sub/project`), and the event must carry the
secret (GitHub's `X-Hub-Signature-256`, GitLab's `X-Gitlab-Token`).

### Webhooks

**Settings → Webhooks** (or `POST /api/v1/projects/{slug}/webhooks`) sends `build.finalized`,
`build.verdict_changed`, `check.reviewed` and `member.added` to a URL. Each delivery is a JSON `POST` with
`X-Pixeltwin-Event`, `X-Pixeltwin-Delivery` (the same id on every retry) and
`X-Pixeltwin-Signature: sha256=<HMAC-SHA256 of the body with the webhook's secret>`:

```json
{
  "id": "dlv_01…", "event": "build.verdict_changed", "createdAt": 1760000000000,
  "project": { "id": "prj_…", "slug": "web", "name": "Web" },
  "build": { "id": "bld_…", "number": 12, "branch": "feature/login", "baseBranch": "main",
             "commitSha": "…", "repository": "acme/shop", "pullRequest": 42, "state": "finalized",
             "verdict": "passed", "previousVerdict": "pending",
             "counts": { "total": 41, "unchanged": 38, "changed": 2, "new": 1, "error": 0,
                         "pending": 0, "approved": 3, "rejected": 0, "outdated": 0 },
             "url": "https://pixeltwin.example.com/ui/builds/bld_…" }
}
```

`check.reviewed` adds `check` (`id`, `name`, `variant`, `result`, `review`, `url`) and `review`
(`action`: approved, rejected or reset; `reason`; `actor`: `id`, `kind` (`user` or `token`) and
`name`). `member.added` (someone joined the project) has no build; it adds `member` (`id`,
`email`, `role`, `via`: `member` when a maintainer or admin added them, `invite` when they accepted
an invite, `access_request` when an admin approved their sign-up; `addedBy`: `id` and `email` of
who added, invited or approved them). Webhooks belong to a project, so new access requests (not yet
in any project) are not sent as a webhook: admins see them under Users and, with SMTP, by mail.
Format *Slack* posts a
Slack-compatible `{ text, blocks }` instead, for an incoming webhook URL. Sending happens in the
background and never slows or fails the request that caused it; a failed delivery (network,
timeout, 5xx, 429) is retried with backoff for about five hours, a 4xx is not. Deliveries wait in
the database, so a restart loses none, and with several replicas each is sent once (at least once
if a replica dies mid-send: dedupe on the delivery id). Each webhook's page shows its last 20
deliveries and has *Send test*. Webhook URLs must be `http(s)`; redirects are not followed.

### Kubernetes

A Helm chart is in [`deploy/helm/pixeltwin`](deploy/helm/pixeltwin/README.md). It has two modes:

- `storage: local` (default): one replica, with SQLite and the images on a ReadWriteOnce PVC.
- `storage: postgres`: images and data live in Postgres, so you can run as many replicas as you
  like with rolling updates, and one `pg_dump` is the whole backup.

```sh
helm install pixeltwin deploy/helm/pixeltwin -n pixeltwin --create-namespace \
  --set publicUrl=https://pixeltwin.example.com \
  --set storage=postgres --set replicaCount=3 \
  --set database.url='postgres://pixeltwin:…@db:5432/pixeltwin'
kubectl -n pixeltwin get secret pixeltwin -o jsonpath='{.data.SETUP_TOKEN}' | base64 -d   # first-run token
```

`publicUrl` is required. It is used for links, the `Secure` cookie flag and the CSRF origin
check. Behind ingress-nginx, the chart raises the body size limit to 20m for uploads.
[`deploy/examples/postgres.yaml`](deploy/examples/postgres.yaml) is a minimal Postgres for trying
it out.

### Configuration

| Variable | Default |
|---|---|
| `PORT` | `8080` |
| `PUBLIC_URL` | `http://localhost:$PORT` (used for links, cookies and the CSRF check) |
| `DATA_DIR` | `./data` |
| `DATABASE_URL` | unset → SQLite in `DATA_DIR`; `postgres://…` for Postgres |
| `DATABASE_POOL_MAX` | `20` (Postgres connections) |
| `STORAGE` | `local`: images are files under `DATA_DIR`; `postgres`: images live in the Postgres database (needs `DATABASE_URL`), so replicas need no shared disk and one database backup covers everything |
| `SETUP_TOKEN` | unset → a random first-run token in the log; set (≥ 16 characters, e.g. from a Kubernetes Secret) to fix it on every replica; it is then never logged |
| `DIFF_WORKERS` | CPUs − 1 (one core stays with the main thread); in a container, its CPU limit counts |
| `DIFF_TIMEOUT_MS` | `30000` |
| `DIFF_QUEUE_MAX` | `DIFF_WORKERS` × 20: while more diffs wait, uploads get `503 server_busy` with `Retry-After`; `0` never refuses |
| `SHUTDOWN_GRACE_MS` | `20000`: on SIGTERM, requests in flight get this long to finish (keep it below Kubernetes' `terminationGracePeriodSeconds`) |
| `SECRET_KEY` | unset → integration tokens and webhook secrets are stored as they are (the settings page says so); set (≥ 32 characters, the same on every replica) to encrypt them with AES-256-GCM. Changing it makes the stored ones unreadable: enter them again |
| `OUTBOUND_BLOCK_PRIVATE` | off: webhooks and GitHub/GitLab calls may reach loopback and private networks (a chat server or GitHub Enterprise next door); `1` refuses them too. Link-local addresses (cloud metadata) are always refused. Project maintainers set webhook and code host URLs too: set `1` when they should not reach your internal network |
| `MAX_IMAGE_BYTES` | `10485760` |
| `MAX_IMAGE_PIXELS` | `40000000` |
| `LOG_LEVEL` | `info` |
| `SMTP_URL` | unset → no mail (links are shown to copy); `smtp://user:pass@host:587` (STARTTLS when offered; credentials only over TLS, except to localhost) or `smtps://…:465` |
| `SMTP_FROM` | needed with `SMTP_URL`, e.g. `pixeltwin <pixeltwin@example.com>` |
| `METRICS` | off; `1` serves Prometheus metrics at `GET /metrics` on `METRICS_PORT`, a port of its own so a proxy or Ingress in front of `PORT` never exposes them (no auth): requests by route and status with latency, checks by result, finalized builds by verdict, diff queue depth, and the webhook / code host / mail outbox backlog (read from the database, so the same on every replica) |
| `METRICS_PORT` | `9464` |

## Post screenshots from your tests: the JavaScript SDK

No `fetch` plumbing: [`@pixeltwin/playwright`](packages/playwright/README.md) for Playwright Test,
[`@pixeltwin/wdio`](packages/wdio/README.md) for WebdriverIO, and the framework-free
[`@pixeltwin/client`](packages/client/README.md) under both. One pixeltwin build per test run
(and per CI run across shards), a summary with review links at the end, and with
`PIXELTWIN_GATE=1` the run fails unless the verdict is `passed`.

```ts
// playwright.config.ts
export default defineConfig({ globalSetup: '@pixeltwin/playwright/setup' /* , …your projects */ });

// tests/home.spec.ts
import { test } from '@pixeltwin/playwright';

test('home', async ({ page, pixeltwin }) => {
  await page.goto('/');
  await pixeltwin.check(page, 'home', { ignore: [page.locator('.clock')] }); // variant: browser + viewport
});
```

```ts
// wdio.conf.ts: services: [[PixeltwinService, { project: 'web' }]]
await browser.pixeltwinCheck('home', { ignore: [$('.clock')] });
```

```sh
PIXELTWIN_URL=http://localhost:8080 PIXELTWIN_TOKEN=pt_… PIXELTWIN_PROJECT=web PIXELTWIN_GATE=1 npx playwright test
```

Until the packages are on npm, install them from a GitHub release (no token needed); install the
client with the framework package, which depends on it:

```sh
R=https://github.com/pixeltwin/pixeltwin/releases/download/v0.1.0
npm install -D $R/pixeltwin-client-0.1.0.tgz $R/pixeltwin-playwright-0.1.0.tgz   # or pixeltwin-wdio-0.1.0.tgz
```

`bun scripts/build-sdk.ts pack <dir>` builds the same tarballs from a checkout.

**Element-aware diffs.** Both SDKs send the boxes of the visible elements with each screenshot
(test ids, roles, a short text, a few styles; at most 300, never what was typed into a field).
When the baseline has them too, the diff says what changed: `diff.changes` lists elements that
moved, resized, changed text or style, appeared or disappeared, and the summary reads
"`button[data-testid=submit]` moved 4 px down; heading text changed from "Sign in" to "Log in"".
`PIXELTWIN_ELEMENTS=0` turns it off.

**Examples** to copy: [`examples/playwright`](examples/playwright/README.md) (full page, element,
ignored clock, Chromium and Firefox on desktop and a phone, sharding with `npx pixeltwin finalize`)
and [`examples/wdio`](examples/wdio/README.md) (a real Chrome through WebdriverIO, desktop and a
phone). Each ships a tiny demo site and a GitHub Actions snippet.

## Agents: `pixeltwin mcp`

`npx pixeltwin mcp` (in `@pixeltwin/client`) is a [Model Context Protocol](https://modelcontextprotocol.io)
server on stdio, so an agent that just changed your UI can check its own work: read what changed,
element by element, look at the screenshots, and approve what it meant to do with a reason. Its
tools: `latest_build` (by branch; the checked-out one by default), `list_changes` (changed and new
checks with their summary and element changes), `get_check`, `get_check_images` (baseline, new
and diff as images, cropped to a change to save tokens), `approve_check` and `reject_check` (with
a `reason`, and rejecting a `reasonCode`; the answer says whether it applied or was recorded as a
suggestion), `review_group`, `rejection_patterns` and `add_ignore_area`. A header changed on 40 screens is one change group: `list_changes` shows it
once, with its members by name and one representative check, and the agent judges it once and
decides all 40 with `review_group` (what applied, what became a suggestion, what was skipped, and
the build's new verdict). Checks on flaky screens carry a `flakyScore`, so the agent treats their
changes as likely noise; `get_check` adds the flips and the unstable area. Every rejection keeps
its reason (`not_loaded`, `late_asset`, `animation`, `dynamic_data`, `environment`, `real_bug`,
`other`, and a comment), and agents learn from them: `list_changes` and `get_check` carry the
screen's recent rejections with a hint ("rejected 3× as not_loaded: likely captured before the page
finished loading — wait for network idle or for the element before the screenshot"),
`rejection_patterns` sums them up, and approving a screen often rejected as not loaded warns that
the change may be a loading artefact. The SDKs end a run with a one-line tip for such screens. For
Claude Code, a
`.mcp.json` in the repository:

```json
{
  "mcpServers": {
    "pixeltwin": {
      "command": "npx",
      "args": ["-y", "--package=@pixeltwin/client", "pixeltwin", "mcp"],
      "env": {
        "PIXELTWIN_URL": "http://localhost:8080",
        "PIXELTWIN_TOKEN": "${PIXELTWIN_TOKEN}",
        "PIXELTWIN_PROJECT": "web"
      }
    }
  }
}
```

The token needs `read` (and `review` to approve or reject); Claude Code fills `${PIXELTWIN_TOKEN}`
from your environment, so the token stays out of the repository. With the client installed in the
project (`npm install -D @pixeltwin/client`, see above for the release tarballs), plain
`"command": "npx", "args": ["pixeltwin", "mcp"]` runs that copy.
To let an agent work without approving anything itself, give its token only `read`, or set the
project's agent review policy to `suggest`.

## Development

```sh
bun test             # SQLite in memory
bun run typecheck
bun run lint         # `bun run format` fixes formatting
bun run openapi      # regenerate openapi.json after changing the API (a test checks it)
bun scripts/build.ts            # binary for this machine in dist/ (`all` for every target)
bun scripts/smoke.ts dist/pixeltwin-*-darwin-arm64   # end-to-end check of a binary
bun scripts/build-sdk.ts        # SDK packages to packages/*/dist (`pack <dir>` for tarballs)
```

The SDK tests (`test/sdk/`, part of `bun test`) start their own server from source on a free port
in 19000–19099 with an empty data dir; `test/sdk/playwright.test.ts` runs a real Playwright suite
(`packages/playwright/test/suite/`) through the SDK, so it needs Chromium (see below).

`bun run examples` (optional, not part of `bun test`) runs both example projects end to end against
a fresh server on a free port in 19100–19179: it packs the SDK into `examples/*/vendor`, runs
`npm install`, then new → approve → unchanged with the gate → `DEMO_CHANGE=1` fails the gate.
It needs npm, Playwright's Chromium and Firefox (`npx playwright install chromium firefox` in
`examples/playwright`) and, the first time, a network connection for WebdriverIO's chromedriver.
`bun run examples playwright` or `… wdio` runs one.

Browser tests (Playwright, Chromium) start their own server from source on port 18777
(`E2E_PORT` to change it); the review flow, dialogs, theme, palette, phone layout and the
no-JavaScript fallback are covered:

```sh
bunx playwright install chromium   # once
bun run e2e
bun run screenshots                # refresh docs/screenshots/ (pixeltwin also compares them itself)
```

Run the tests against Postgres too:

```sh
docker run -d --rm --name pixeltwin-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pixeltwin_test -p 55432:5432 postgres:17
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/pixeltwin_test bun test
docker stop pixeltwin-pg
```

`TEST_DATABASE_URL` tables are truncated before each test. Never point it at a database you care about.

### Releasing

Bump the version in `src/version.ts`, the Helm chart's `appVersion` and `packages/*/package.json`
(their `version` and the `@pixeltwin/client` dependency), commit, then push a tag `v<version>`. The release workflow checks that the tag
matches, runs the tests and the smoke test, attaches the binaries, `SHA256SUMS` and the SDK tarballs
to a GitHub release, and pushes the image to GHCR. With an `NPM_TOKEN` repository secret (an npm
automation token that can publish `@pixeltwin/*`) it also publishes the SDK packages to npm, with
provenance; without one that job only leaves a notice. The SDK packages carry the server's version
(a test checks). GHCR packages start private: after the first release, open
the package's settings on GitHub and set its visibility to public, or `docker pull` will ask for a
login.

## Licence

Apache-2.0
