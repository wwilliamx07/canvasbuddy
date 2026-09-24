import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { SCHEMA_SQL } from '../../src/db/schema';
import { __setTestDb } from '../../src/db/pglite';

/**
 * An isolated in-memory database with the production schema and the HNSW settings `getDB()`
 * applies, injected so every `getDB()` / `withTransaction` in the code under test uses it. No
 * data dir, so nothing touches IndexedDB; `navigator.locks` is never involved.
 */
export async function openTestDb(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { vector } });
  await db.exec(SCHEMA_SQL);
  await db.exec('SET hnsw.iterative_scan = relaxed_order; SET hnsw.max_scan_tuples = 200000');
  __setTestDb(db);
  return db;
}

/** Every table the schema creates, read from the schema itself so a new table is never missed. */
const TABLES = [...SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);

export async function resetTestDb(db: PGlite): Promise<void> {
  await db.exec(`TRUNCATE ${TABLES.join(', ')} CASCADE`);
}

export async function count(db: PGlite, table: string, where = 'TRUE', params: unknown[] = []): Promise<number> {
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return r.rows[0].n;
}
