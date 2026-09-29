import pg from 'pg';

/** One statement's result, in the one shape every store reads. */
export interface QueryResult<T> {
  rows: T[];
}

/** What a store can run -- on the root handle or inside a transaction. */
export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/**
 * The slice of PGlite the stores use. PGlite satisfies it structurally, and so
 * does `PgNetworkDb`, which is how one set of stores runs on either: an
 * embedded WASM Postgres in a data directory, or a network Postgres named by a
 * connection string (Supabase in the hosted deployment).
 */
export interface Db extends Queryable {
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface NetworkDbOptions {
  /** A `postgres://` connection string. */
  url: string;
  /**
   * Postgres schema to hold Rein's tables, created if missing and set as the
   * connection's `search_path`. Lets services share one database without
   * sharing tables (the console's world must never be the engine's), and lets
   * tests isolate themselves the way a fresh temp dir does for PGlite.
   * Omit for the server's default (`public`).
   */
  schema?: string;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * A network Postgres behind PGlite's contract -- on ONE connection, on purpose.
 *
 * PGlite runs every statement on a single connection in submission order, and
 * the stores lean on that without saying so. The case that was measured
 * (S84): `policies.seq` is `MAX(seq) + 1` computed inside the insert, so on a
 * connection POOL concurrent upserts each read the same MAX and tie, and a
 * restart resumes first-applicable-wins in whatever order Postgres returns
 * the tie -- a deny evaluated first can come back evaluated second. Rather
 * than audit every store for the same assumption (fire-and-forget writes, a
 * later write for a row landing after an earlier one), one serialized
 * connection gives the network driver exactly the ordering the embedded one
 * has. (The decision chain is NOT the reason: DecisionLog serializes its own
 * appends.) The cost is no parallelism, which an engine whose reads come from
 * memory does not miss.
 *
 * `transaction()` holds the queue for its whole body, as PGlite's does, so no
 * other statement can land between its BEGIN and COMMIT on the shared
 * connection. Statements issued through `tx` run immediately; anything issued
 * on the root handle meanwhile waits.
 *
 * A dropped connection is replaced on the next statement rather than retried
 * under the caller: a statement that was in flight when the socket died may
 * or may not have committed, and only the caller knows whether re-running it
 * is safe. It fails, the way a PGlite I/O error fails.
 */
export class PgNetworkDb implements Db {
  private client: pg.Client | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(private readonly options: NetworkDbOptions) {}

  static async open(options: NetworkDbOptions): Promise<PgNetworkDb> {
    if (options.schema !== undefined && !SCHEMA_NAME.test(options.schema)) {
      // Interpolated into DDL below (identifiers cannot be bind parameters),
      // so the name is held to a shape that needs no quoting at all.
      throw new TypeError(
        `invalid schema name ${JSON.stringify(options.schema)}: lowercase letters, digits and _ only`,
      );
    }
    const db = new PgNetworkDb(options);
    await db.run((client) => client.query('SELECT 1'));
    return db;
  }

  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.run((client) => runQuery<T>(client, sql, params));
  }

  exec(sql: string): Promise<unknown> {
    // No parameters -> the simple-query protocol, which (like PGlite's exec)
    // accepts several statements in one string.
    return this.run((client) => client.query(sql));
  }

  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.run(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await fn({ query: (sql, params) => runQuery(client, sql, params) });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Let everything already queued finish first: closing under an in-flight
    // statement is how a write-behind flush gets lost.
    await this.queue.catch(() => undefined);
    const client = this.client;
    this.client = undefined;
    if (client) await client.end().catch(() => undefined);
  }

  /** Serialize `op` behind everything issued before it. */
  private run<T>(op: (client: pg.Client) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      if (this.closed && this.client === undefined) throw new Error('database handle is closed');
      return op(await this.connection());
    });
    // The queue must survive a failed statement; the caller still sees it.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async connection(): Promise<pg.Client> {
    if (this.client) return this.client;
    const client = new pg.Client({ connectionString: this.options.url });
    // An idle socket that dies (pooler restart, network blip) emits 'error'
    // with no statement to reject; unhandled, that kills the process. Drop
    // the connection instead so the next statement opens a fresh one.
    const drop = () => {
      if (this.client === client) this.client = undefined;
    };
    client.on('error', (err) => {
      console.warn(`[rein] database connection lost (${err.message}); reconnecting on next use`);
      drop();
    });
    client.on('end', drop);
    await client.connect();
    try {
      const schema = this.options.schema;
      if (schema) {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
        await client.query(`SET search_path TO ${schema}`);
      }
    } catch (err) {
      await client.end().catch(() => undefined);
      throw err;
    }
    this.client = client;
    return client;
  }
}

async function runQuery<T>(
  client: pg.Client,
  sql: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const res = await client.query(sql, params as unknown[] | undefined);
  return { rows: res.rows as T[] };
}
