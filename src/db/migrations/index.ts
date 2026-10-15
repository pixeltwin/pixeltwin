import type { Migration, MigrationProvider } from 'kysely/migration';
import * as m0001 from './0001_init';

// Static list: a compiled binary has no migrations directory to scan.
const migrations: Record<string, Migration> = {
  '0001_init': m0001,
};

export const migrationProvider: MigrationProvider = {
  getMigrations: async () => migrations,
};
