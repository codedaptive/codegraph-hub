import { inProcessJobRunner } from './helpers/in-process-job-runner';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuilderService } from '../../../src/extensions/host/builder/service';

let root: string;
let dbPath: string;
let service: BuilderService | undefined;

function freelist(): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('PRAGMA freelist_count').get();
    if (!row || typeof row.freelist_count !== 'number') throw new Error('missing freelist_count');
    return row.freelist_count;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vacuum-')));
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, '.codegraph'));
  dbPath = path.join(root, '.codegraph', 'codegraph.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE payload (data BLOB); BEGIN;');
    const insert = db.prepare('INSERT INTO payload VALUES (zeroblob(4096))');
    for (let i = 0; i < 256; i++) insert.run();
    db.exec('COMMIT; DELETE FROM payload; PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    db.close();
  }
});

afterEach(async () => {
  await service?.stop(1000);
  service = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('builder vacuum after a job', () => {
  it.each([
    { disk: 1_000_000_000, shouldVacuum: true },
    { disk: 0, shouldVacuum: false },
  ])('respects available disk $disk', async ({ disk, shouldVacuum }) => {
    const lines: string[] = [];
    service = new BuilderService({ runJob: inProcessJobRunner().runJob,
      send: () => {},
      jobLog: (line) => { lines.push(line); },
      log: () => {},
      housekeeping: false,
      vacuum: { minFreelistBytes: 65536, freeDiskBytes: () => disk },
    });
    const beforeSize = fs.statSync(dbPath).size;
    const beforeFree = freelist();
    expect(beforeFree).toBeGreaterThan(16);
    await service.queue.enqueue('sync', root, async () => {});
    await service.queue.whenRootIdle(root);
    await service.queue.whenIdle();
    if (shouldVacuum) {
      expect(fs.statSync(dbPath).size).toBeLessThan(beforeSize);
      expect(freelist()).toBeLessThanOrEqual(1);
      expect(lines.some((line) => line.includes(`job end vacuum ${root} ok`))).toBe(true);
    } else {
      expect(fs.statSync(dbPath).size).toBe(beforeSize);
      expect(freelist()).toBe(beforeFree);
      expect(lines.some((line) => line.includes('vacuum skipped') && line.includes(root))).toBe(true);
    }
  });
});
