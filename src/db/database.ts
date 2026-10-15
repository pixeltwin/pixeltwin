import { Database as BunDatabase } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { BunSqliteDialect } from './bun-sqlite-dialect';
import { migrationProvider } from './migrations';
import type { DB } from './schema';

export type Db = Kysely<DB>;
export type DbKind = 'sqlite' | 'postgres';

export interface DatabaseHandle {
  db: Db;
  kind: DbKind;
  close(): Promise<void>;
}

// Postgres returns int8 (bigint, count(*)) as strings. Epoch milliseconds and counts fit in 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

/** Opens `postgres://…`, `postgresql://…` or `sqlite:<path>` (`sqlite::memory:` for tests). */
export function openDatabase(url: string): DatabaseHandle {
  const plugins = [new CamelCasePlugin()];

  if (/^postgres(ql)?:\/\//.test(url)) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins });
    return { db, kind: 'postgres', close: () => db.destroy() };
  }

  if (url.startsWith('sqlite:')) {
    const path = url.slice('sqlite:'.length);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const sqlite = new BunDatabase(path, { create: true });
    sqlite.exec('PRAGMA journal_mode = WAL');
    sqlite.exec('PRAGMA foreign_keys = ON');
    sqlite.exec('PRAGMA busy_timeout = 5000');
    const db = new Kysely<DB>({ dialect: new BunSqliteDialect(sqlite), plugins });
    return { db, kind: 'sqlite', close: () => db.destroy() };
  }

  throw new Error('Unsupported database URL: expected postgres://, postgresql:// or sqlite:');
}

/** Applies pending migrations and returns the names of those applied. */
export async function migrateToLatest(db: Db): Promise<string[]> {
  const migrator = new Migrator({ db, provider: migrationProvider });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

export function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message.includes('UNIQUE constraint failed');
}
