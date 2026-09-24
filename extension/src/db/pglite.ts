import { PGlite, type Transaction } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { SCHEMA_SQL } from './schema';

/** Anything that can run a parameterized query: the database itself or an open transaction. */
export type Queryable = Pick<Transaction, 'query'>;

/**
 * Runs `fn` inside one transaction so a multi-statement sync is all-or-nothing and the
 * IndexedDB VFS flushes once instead of per statement.
 */
export async function withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const db = await getDB();
  return db.transaction(fn);
}

/** The db, or the transaction when one is being threaded through. */
export async function q(tx?: Queryable): Promise<Queryable> {
  return tx ?? (await getDB());
}

let dbInstance: PGlite | null = null;
let dbInitPromise: Promise<PGlite> | null = null;
let dbName: string | null = null;

/**
 * Each Canvas identity has its own database (see `canvas/identity.ts`); the name is set once at
 * startup, before anything calls `getDB()`. Nothing else may name a data dir.
 */
export function configureDatabase(name: string): void {
  if (dbInstance && dbName !== name) throw new Error('The memory is already open under another name; reload to switch.');
  dbName = name;
}

/** Closes the open database (before deleting it); the next getDB() reopens it. */
export async function closeDB(): Promise<void> {
  const db = dbInstance;
  dbInstance = null;
  dbInitPromise = null;
  if (db) await db.close();
}

/**
 * PGlite's IndexedDB filesystem is not safe to open from two pages at once, and Chrome opens one
 * side panel per window. Hold a Web Lock for the lifetime of this page; a second page gets a
 * clear error instead of silently corrupting the database.
 */
let heldLock: string | null = null;

async function acquireExclusiveLock(name: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.locks) return;
  // Held until the page unloads: a retry after a failed init, or a reopen after closeDB, already has it
  if (heldLock === name) return;

  const acquired = await new Promise<boolean>((resolve) => {
    navigator.locks
      .request(`canvas-buddy-pglite:${name}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return Promise.resolve();
        }
        resolve(true);
        // Never resolve: the lock is released automatically when this page unloads.
        return new Promise<void>(() => {});
      })
      .catch(() => resolve(true)); // locks API misbehaving is not worth blocking the app over
  });

  if (!acquired) {
    throw new Error(
      'CanvasBuddy is already open in another browser window. Close it there to use it here.'
    );
  }
  heldLock = name;
}

/**
 * Initializes and returns the persistent PGlite database singleton for the configured identity,
 * backed by IndexedDB ('idb://<dbName>') with pgvector enabled.
 */
export async function getDB(): Promise<PGlite> {
  if (dbInstance) {
    return dbInstance;
  }

  if (dbInitPromise) {
    return dbInitPromise;
  }

  const name = dbName;
  if (!name) throw new Error('Memory is not open yet. Connect to Canvas first.');

  dbInitPromise = (async () => {
    try {
      await acquireExclusiveLock(name);
      const db = await PGlite.create(`idb://${name}`, {
        extensions: {
          vector,
        },
      });

      // Run schema migrations and vector initialization
      await db.exec(SCHEMA_SQL);
      // HNSW scans stop after ef_search candidates; with a WHERE filter that can return fewer rows
      // than LIMIT. Iterative scan keeps walking the graph until the limit is met (pgvector >= 0.8).
      // The tuple cap is raised so a search restricted to one small document inside a large corpus
      // still fills its LIMIT instead of giving up early.
      await db.exec('SET hnsw.iterative_scan = relaxed_order; SET hnsw.max_scan_tuples = 200000');

      dbInstance = db;
      return db;
    } catch (error) {
      dbInitPromise = null;
      console.error('Failed to initialize PGlite database:', error);
      throw error;
    }
  })();

  return dbInitPromise;
}


/** Test hook: inject an already-open instance (Node smoke tests); never used by the extension. */
export function __setTestDb(db: PGlite): void {
  dbInstance = db;
}
