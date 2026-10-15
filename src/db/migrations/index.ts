import type { Migration, MigrationProvider } from 'kysely/migration';
import * as m0001 from './0001_init';
import * as m0002 from './0002_retention_indexes';
import * as m0003 from './0003_build_numbers';

// Static list: a compiled binary has no migrations directory to scan.
const migrations: Record<string, Migration> = {
  '0001_init': m0001,
  '0002_retention_indexes': m0002,
  '0003_build_numbers': m0003,
};

export const migrationProvider: MigrationProvider = {
  getMigrations: async () => migrations,
};
