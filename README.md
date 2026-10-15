# pixeltwin

Self-hosted visual regression testing with an API built for CI and AI agents.

> Status: early development. The engine (database, storage, diffing, domain rules) exists;
> the HTTP API, web UI and release builds are in progress. See `docs/superpowers/specs/`.

## Development

Requires [Bun](https://bun.sh) (version in `.bun-version`).

```sh
bun install
bun test             # SQLite in memory
bun run typecheck
bun run lint         # `bun run format` fixes formatting
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
