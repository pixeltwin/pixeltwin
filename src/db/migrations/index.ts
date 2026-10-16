import type { Migration, MigrationProvider } from 'kysely/migration';
import * as m0001 from './0001_init';
import * as m0002 from './0002_retention_indexes';
import * as m0003 from './0003_build_numbers';
import * as m0004 from './0004_review_events';
import * as m0005 from './0005_snapshot_areas';
import * as m0006 from './0006_outdated_checks';
import * as m0007 from './0007_stored_objects';
import * as m0008 from './0008_parallel_builds';
import * as m0009 from './0009_auto_approve_new';

// Static list: a compiled binary has no migrations directory to scan.
const migrations: Record<string, Migration> = {
  '0001_init': m0001,
  '0002_retention_indexes': m0002,
  '0003_build_numbers': m0003,
  '0004_review_events': m0004,
  '0005_snapshot_areas': m0005,
  '0006_outdated_checks': m0006,
  '0007_stored_objects': m0007,
  '0008_parallel_builds': m0008,
  '0009_auto_approve_new': m0009,
};

export const migrationProvider: MigrationProvider = {
  getMigrations: async () => migrations,
};
