import type { Database } from 'bun:sqlite';
import {
  CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';

type SqlParam = string | number | bigint | boolean | null | Uint8Array;

class BunSqliteConnection implements DatabaseConnection {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const statement = this.#db.prepare(query.sql);
    const params = query.parameters as SqlParam[];
    if (statement.columnNames.length > 0) {
      return { rows: statement.all(...params) as R[] };
    }
    const result = statement.run(...params);
    return { rows: [], numAffectedRows: BigInt(result.changes), insertId: BigInt(result.lastInsertRowid) };
  }

  // biome-ignore lint/correctness/useYield: streaming is intentionally unsupported
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Streaming queries are not supported by the bun:sqlite dialect.');
  }
}

/** Serializes access to the single bun:sqlite connection. */
class ConnectionMutex {
  #tail: Promise<void> = Promise.resolve();

  async lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    await previous;
    return release;
  }
}

class BunSqliteDriver implements Driver {
  readonly #db: Database;
  readonly #connection: BunSqliteConnection;
  readonly #mutex = new ConnectionMutex();
  #release: (() => void) | undefined;

  constructor(db: Database) {
    this.#db = db;
    this.#connection = new BunSqliteConnection(db);
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    this.#release = await this.#mutex.lock();
    return this.#connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }

  async releaseConnection(): Promise<void> {
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }

  async destroy(): Promise<void> {
    this.#db.close();
  }
}

/**
 * Kysely dialect for Bun's built-in SQLite driver. There is one connection; queries are
 * serialized. Inside `db.transaction()` use only the transaction object: a query on the
 * outer `db` waits for the transaction to finish and deadlocks.
 */
export class BunSqliteDialect implements Dialect {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  createAdapter() {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new BunSqliteDriver(this.#db);
  }

  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }

  createIntrospector(db: Kysely<unknown>) {
    return new SqliteIntrospector(db);
  }
}
