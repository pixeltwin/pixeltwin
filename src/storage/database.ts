import type { Db } from '../db/database';
import type { Storage } from './storage';

/**
 * Stores objects in the database itself (STORAGE=postgres): every replica reads and writes the
 * same images without a shared disk, and a database backup covers them.
 */
export class DatabaseStorage implements Storage {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    await this.#db
      .insertInto('storedObjects')
      .values({ key, data, createdAt: Date.now() })
      .onConflict((oc) => oc.column('key').doUpdateSet({ data, createdAt: Date.now() }))
      .execute();
  }

  async get(key: string): Promise<Uint8Array | null> {
    const row = await this.#db.selectFrom('storedObjects').select('data').where('key', '=', key).executeTakeFirst();
    // Postgres returns a Buffer (a Uint8Array subclass); hand out a plain Uint8Array either way.
    return row ? new Uint8Array(row.data) : null;
  }

  async exists(key: string): Promise<boolean> {
    const row = await this.#db.selectFrom('storedObjects').select('key').where('key', '=', key).executeTakeFirst();
    return row !== undefined;
  }

  async delete(key: string): Promise<void> {
    await this.#db.deleteFrom('storedObjects').where('key', '=', key).execute();
  }
}
