# pixeltwin

Self-hosted visual regression testing with an API built for CI and AI agents.

> Status: early development (0.x). See `docs/superpowers/specs/` for the design.

![Branches of a project: main passed, a feature branch waiting for review](docs/screenshots/branches-light.png)

Review a build with the keyboard: Side, Slider, Onion and Diff views, zoom to a changed region,
<kbd>A</kbd> approve, <kbd>R</kbd> reject, <kbd>U</kbd> undo, <kbd>→</kbd>/<kbd>←</kbd> (or <kbd>J</kbd>/<kbd>K</kbd>)
next and previous, <kbd>?</kbd> for every shortcut.

![Reviewing a changed check in the slider view, dark theme](docs/screenshots/review-slider-dark.png)

## Run it

**Docker** (images for amd64 and arm64 are published by the release workflow to
`ghcr.io/<owner>/pixeltwin`, where `<owner>` is the GitHub account hosting this repository):

```sh
docker run -d --name pixeltwin -p 8080:8080 -v pixeltwin-data:/data \
  -e PUBLIC_URL=http://localhost:8080 ghcr.io/<owner>/pixeltwin:latest
docker logs pixeltwin          # shows the setup link
```

The container runs as uid 65532 (distroless `nonroot`). A named volume works as is; a bind-mounted
directory must be writable by that user, for example `sudo chown -R 65532:65532 ./pixeltwin-data`.

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

Admins create projects, users and CI tokens in the UI. Over the API it looks like this (reference at `/docs`):

```sh
curl -c cookies -X POST http://localhost:8080/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"at least 10 characters"}'
curl -b cookies -H 'origin: http://localhost:8080' -H 'content-type: application/json' \
  -X POST http://localhost:8080/api/v1/projects -d '{"slug":"web","name":"Web"}'
curl -b cookies -H 'origin: http://localhost:8080' -H 'content-type: application/json' \
  -X POST http://localhost:8080/api/v1/projects/web/tokens -d '{"name":"CI","scopes":["read","write"]}'
```

The workflow for CI and agents is in `/llms.txt`; the full contract is `/openapi.json`.

Other commands: `migrate`, `admin reset-password <email>`, and `healthcheck` (exit 0 when the server
on `PORT` answers; the Docker image uses it).

Builds older than a project's retention period (90 days by default, set per project) and images
nothing references any more are deleted by an hourly job.

### Configuration

| Variable | Default |
|---|---|
| `PORT` | `8080` |
| `PUBLIC_URL` | `http://localhost:$PORT` (used for links, cookies and the CSRF check) |
| `DATA_DIR` | `./data` |
| `DATABASE_URL` | unset → SQLite in `DATA_DIR`; `postgres://…` for Postgres |
| `DIFF_WORKERS` | CPU count |
| `DIFF_TIMEOUT_MS` | `30000` |
| `MAX_IMAGE_BYTES` | `10485760` |
| `MAX_IMAGE_PIXELS` | `40000000` |
| `LOG_LEVEL` | `info` |

## Development

```sh
bun test             # SQLite in memory
bun run typecheck
bun run lint         # `bun run format` fixes formatting
bun run openapi      # regenerate openapi.json after changing the API (a test checks it)
bun scripts/build.ts            # binary for this machine in dist/ (`all` for every target)
bun scripts/smoke.ts dist/pixeltwin-*-darwin-arm64   # end-to-end check of a binary
```

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

Bump `src/version.ts`, commit, then push a tag `v<version>`. The release workflow checks that the tag
matches, runs the tests and the smoke test, attaches the binaries and `SHA256SUMS` to a GitHub
release, and pushes the image to GHCR. GHCR packages start private: after the first release, open
the package's settings on GitHub and set its visibility to public, or `docker pull` will ask for a
login.

## Licence

Apache-2.0
