/**
 * `blast/store.ts`: what `openBlastStore` leaves behind when the index cannot
 * serve its queries.
 *
 * The fixture is a real SQLite file at `.codegraph/codegraph.db` holding one
 * unrelated table, so the read-only open succeeds and the store's first
 * statement (`... FROM nodes`) fails to prepare.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection, getDatabasePath } from '../../../src/db';
import { createDatabase } from '../../../src/db/sqlite-adapter';
import { openBlastStore } from '../../../src/extensions/queries/blast/store';

describe('openBlastStore on an index without the expected tables', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('throws the prepare error and closes the connection it opened', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-store-'));
    dirs.push(root);
    const dbPath = getDatabasePath(root);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { db } = createDatabase(dbPath);
    db.exec('CREATE TABLE unrelated (x INTEGER)');
    db.close();

    // The spy calls through; it only records the connection openBlastStore got,
    // which the store never hands back once its setup throws.
    const open = vi.spyOn(DatabaseConnection, 'open');
    let conn: DatabaseConnection | undefined;
    try {
      expect(() => openBlastStore(root)).toThrow(/no such table: nodes/);
      expect(open).toHaveBeenCalledTimes(1);
      // The open itself returned, so the throw came from the store's setup.
      expect(open.mock.results[0]?.type).toBe('return');
      conn = open.mock.results[0]?.value as DatabaseConnection;
      expect(conn.isOpen()).toBe(false);
    } finally {
      // A failing run must not leave the handle open on the temp dir.
      if (conn?.isOpen()) conn.close();
    }
  });
});
