# pixeltwin

Self-hosted visual regression testing with an API built for CI and AI agents.

> Status: early development. The engine, the HTTP API and the review UI work; release builds
> (binaries, Docker image) are in progress. See `docs/superpowers/specs/`.

## Run it

Requires [Bun](https://bun.sh) (version in `.bun-version`).

```sh
bun install
bun src/main.ts serve        # http://localhost:8080, data in ./data (SQLite + images)
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

Other commands: `bun src/main.ts migrate`, `bun src/main.ts admin reset-password <email>`.

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
```

Run the tests against Postgres too:

```sh
docker run -d --rm --name pixeltwin-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pixeltwin_test -p 55432:5432 postgres:17
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/pixeltwin_test bun test
docker stop pixeltwin-pg
```

`TEST_DATABASE_URL` tables are truncated before each test. Never point it at a database you care about.

## Licence

Apache-2.0
