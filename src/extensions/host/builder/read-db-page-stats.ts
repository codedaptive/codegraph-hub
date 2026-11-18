/**
 * The page counts (./db-page-stats-type.ts) of the database at `dbPath`, read through a read-only connection of
 * its own so the read never writes or creates the file. Null when the file is missing or any step fails: the
 * VACUUM rule then does nothing.
 */
import { existsSync } from 'node:fs';
import { createDatabase, type SqliteDatabase } from '../../../db/sqlite-adapter';
import type { DbPageStats } from './db-page-stats-type';

function pragmaNumber(db: SqliteDatabase, name: string): number {
  const value: unknown = db.pragma(name, { simple: true });
  if (typeof value !== 'number') throw new Error(`PRAGMA ${name} gave no number`);
  return value;
}

export function readDbPageStats(dbPath: string): DbPageStats | null {
  if (!existsSync(dbPath)) return null;
  try {
    const { db } = createDatabase(dbPath, { readOnly: true });
    try {
      return {
        pageSize: pragmaNumber(db, 'page_size'),
        pageCount: pragmaNumber(db, 'page_count'),
        freelistCount: pragmaNumber(db, 'freelist_count'),
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
