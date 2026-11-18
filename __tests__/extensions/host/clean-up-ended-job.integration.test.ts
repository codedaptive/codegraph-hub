import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanUpEndedJob } from '../../../src/extensions/host/builder/clean-up-ended-job';
import { isCreatedDatabase } from '../../../src/extensions/host/builder/is-created-database';
import { DatabaseSync } from 'node:sqlite';

let root: string;
let dir: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-clean-ended-')));
  dir = path.join(root, '.codegraph');
  fs.mkdirSync(dir);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function lock(name: string, pid: number): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid, mode: 'cold-build', startedAt: 0 }));
}

describe('cleanUpEndedJob', () => {
  it.each([['rebuild.pid', 'writer.pid'], ['writer.pid', 'rebuild.pid']])('removes %s for the ended pid and preserves %s for another', (own, other) => {
    lock(own, 123);
    lock(other, 124);
    cleanUpEndedJob('sync', root, 123, () => false);
    expect(fs.existsSync(path.join(dir, own))).toBe(false);
    expect(fs.existsSync(path.join(dir, other))).toBe(true);
  });

  it.each([[true, false], [false, true]])('removes a cold database only when its identity matches (%s)', (matches, remains) => {
    const names = ['codegraph.db', 'codegraph.db-wal', 'codegraph.db-shm', 'codegraph.db-journal'];
    for (const name of names) fs.writeFileSync(path.join(dir, name), 'partial');
    lock('rebuild.pid', 123);
    const seen: string[][] = [];
    cleanUpEndedJob('cold-build', root, 123, (givenRoot, dbFile) => { seen.push([givenRoot, dbFile]); return matches; });
    expect(seen).toEqual([[root, path.join(dir, 'codegraph.db')]]);
    for (const name of names) expect(fs.existsSync(path.join(dir, name))).toBe(remains);
  });

  it('discards the database and releases rebuild.pid when the killed cold build reported no identity', () => {
    const dbPath = path.join(dir, 'codegraph.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE schema_versions (version INTEGER)');
    db.close();
    for (const suffix of ['-wal', '-shm', '-journal']) fs.writeFileSync(dbPath + suffix, 'partial');
    lock('rebuild.pid', 999999);
    cleanUpEndedJob('cold-build', root, 999999, isCreatedDatabase(null));
    for (const suffix of ['', '-wal', '-shm', '-journal']) expect(fs.existsSync(dbPath + suffix)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(false);
  });

  it('keeps the database for another live writer and releases the killed child rebuild lock', () => {
    const dbPath = path.join(dir, 'codegraph.db');
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.writeFileSync(dbPath + suffix, 'live writer data');
    lock('rebuild.pid', 999999);
    lock('writer.pid', process.pid);
    cleanUpEndedJob('cold-build', root, 999999, isCreatedDatabase(null));
    for (const suffix of ['', '-wal', '-shm', '-journal']) expect(fs.readFileSync(dbPath + suffix, 'utf8')).toBe('live writer data');
    expect(fs.existsSync(path.join(dir, 'writer.pid'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(false);
  });

  it('keeps the cold database when the rebuild lock names another pid', () => {
    fs.writeFileSync(path.join(dir, 'codegraph.db'), 'other');
    lock('rebuild.pid', 124);
    cleanUpEndedJob('cold-build', root, 123, () => true);
    expect(fs.readFileSync(path.join(dir, 'codegraph.db'), 'utf8')).toBe('other');
  });

  it('removes seed staging of the ended pid and preserves another pid', () => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.writeFileSync(path.join(dir, `codegraph.db.seed-123-ab.tmp${suffix}`), 'own');
    fs.writeFileSync(path.join(dir, 'codegraph.db.seed-124-ab.tmp'), 'other');
    cleanUpEndedJob('seed', root, 123, () => false);
    for (const suffix of ['', '-wal', '-shm', '-journal']) expect(fs.existsSync(path.join(dir, `codegraph.db.seed-123-ab.tmp${suffix}`))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'codegraph.db.seed-124-ab.tmp'), 'utf8')).toBe('other');
  });
});
