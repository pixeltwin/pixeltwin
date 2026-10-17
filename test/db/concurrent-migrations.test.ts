import { expect, test } from 'bun:test';
import { sql } from 'kysely';
import { migrateToLatest, openDatabase } from '../../src/db/database';
import { migrationProvider } from '../../src/db/migrations';

// Several replicas starting at once against an empty Postgres (a fresh Helm install, or a rollout
// with new migrations) all call migrateToLatest. Kysely's migration lock serializes them: exactly
// one applies the migrations, the others find nothing left, and none fails.
const url = process.env.TEST_DATABASE_URL;

test.skipIf(!url?.startsWith('postgres'))(
  'replicas migrating an empty Postgres at the same time apply each migration exactly once',
  async () => {
    const admin = openDatabase(url as string);
    const name = `pixeltwin_migrate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await sql`create database ${sql.id(name)}`.execute(admin.db);
    const target = new URL(url as string);
    target.pathname = `/${name}`;
    const replicas = Array.from({ length: 4 }, () => openDatabase(target.href, { poolMax: 2 }));
    try {
      const results = await Promise.all(replicas.map((r) => migrateToLatest(r.db)));
      const all = Object.keys(await migrationProvider.getMigrations()).sort();
      expect(results.filter((applied) => applied.length > 0)).toEqual([all]);
      expect(results.filter((applied) => applied.length === 0)).toHaveLength(3);
      const rows = await sql<{ n: number }>`select count(*)::int as n from kysely_migration`.execute(
        replicas[0]?.db as never,
      );
      expect(rows.rows[0]?.n).toBe(all.length);
    } finally {
      await Promise.all(replicas.map((r) => r.close()));
      await sql`drop database if exists ${sql.id(name)}`.execute(admin.db);
      await admin.close();
    }
  },
  60_000,
);
