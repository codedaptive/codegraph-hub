import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDbPageStats } from '../../../src/extensions/host/builder/read-db-page-stats';

const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-page-stats-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('readDbPageStats', () => {
  it('reports page size, file size and freed pages before and after deletions', () => {
    const file = path.join(dir, 'index.db');
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA page_size=4096; PRAGMA journal_mode=WAL; CREATE TABLE payload (data BLOB); BEGIN;');
      const insert = db.prepare('INSERT INTO payload VALUES (zeroblob(4096))');
      for (let i = 0; i < 256; i++) insert.run();
      db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
      const before = readDbPageStats(file);
      expect(before).not.toBeNull();
      expect(before?.pageSize).toBe(4096);
      expect(before?.freelistCount).toBe(0);
      expect((before?.pageCount ?? 0) * 4096).toBe(fs.statSync(file).size);

      db.exec('DELETE FROM payload; PRAGMA wal_checkpoint(TRUNCATE);');
      const after = readDbPageStats(file);
      expect(after).not.toBeNull();
      expect(after?.pageSize).toBe(4096);
      expect(after?.freelistCount).toBeGreaterThan(0);
      expect((after?.pageCount ?? 0) * 4096).toBe(fs.statSync(file).size);
    } finally {
      db.close();
    }
  });

  it('returns null without creating a missing file', () => {
    const file = path.join(dir, 'missing.db');
    expect(readDbPageStats(file)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('returns null for a non-SQLite file', () => {
    const file = path.join(dir, 'not-a-database');
    fs.writeFileSync(file, 'this is not a SQLite database');
    expect(readDbPageStats(file)).toBeNull();
  });
});
