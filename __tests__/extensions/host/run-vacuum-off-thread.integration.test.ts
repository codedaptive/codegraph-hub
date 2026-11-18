import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runVacuumOffThread } from '../../../src/extensions/host/builder/run-vacuum-off-thread';

const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vacuum-worker-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('runVacuumOffThread', () => {
  it('clears a large freelist and shrinks the WAL-mode main file', async () => {
    const file = path.join(dir, 'index.db');
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA page_size=4096; PRAGMA journal_mode=WAL; CREATE TABLE payload (data BLOB); BEGIN;');
      const insert = db.prepare('INSERT INTO payload VALUES (zeroblob(4096))');
      for (let i = 0; i < 256; i++) insert.run();
      db.exec('COMMIT; DELETE FROM payload; PRAGMA wal_checkpoint(TRUNCATE);');
      expect(db.prepare('PRAGMA freelist_count').get()?.freelist_count).toBeGreaterThan(100);
      const before = fs.statSync(file).size;
      await runVacuumOffThread(file);
      expect(db.prepare('PRAGMA freelist_count').get()?.freelist_count).toBe(0);
      expect(fs.statSync(file).size).toBeLessThan(before);
    } finally {
      db.close();
    }
  });

  it('rejects a path containing a non-database file', async () => {
    const file = path.join(dir, 'not-a-database');
    fs.writeFileSync(file, 'this is not a SQLite database');
    await expect(runVacuumOffThread(file)).rejects.toThrow();
  });
});
