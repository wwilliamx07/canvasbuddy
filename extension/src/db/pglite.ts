import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { SCHEMA_SQL } from './schema';

let dbInstance: PGlite | null = null;
let dbInitPromise: Promise<PGlite> | null = null;

const LOCK_NAME = 'canvas-buddy-pglite';

/**
 * PGlite's IndexedDB filesystem is not safe to open from two pages at once, and Chrome opens one
 * side panel per window. Hold a Web Lock for the lifetime of this page; a second page gets a
 * clear error instead of silently corrupting the database.
 */
async function acquireExclusiveLock(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.locks) return;

  const acquired = await new Promise<boolean>((resolve) => {
    navigator.locks
      .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
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
      'CanvasBuddy is already open in another browser window. Close it there to use the knowledge graph here.'
    );
  }
}

/**
 * Initializes and returns the persistent PGlite database singleton
 * backed by IndexedDB ('idb://canvas-buddy-db') with pgvector enabled.
 */
export async function getDB(): Promise<PGlite> {
  if (dbInstance) {
    return dbInstance;
  }

  if (dbInitPromise) {
    return dbInitPromise;
  }

  dbInitPromise = (async () => {
    try {
      await acquireExclusiveLock();
      const db = await PGlite.create('idb://canvas-buddy-db', {
        extensions: {
          vector,
        },
      });

      // Run schema migrations and vector initialization
      await db.exec(SCHEMA_SQL);

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

