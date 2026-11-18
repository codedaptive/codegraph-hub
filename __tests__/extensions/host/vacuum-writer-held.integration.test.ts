import { inProcessJobRunner } from './helpers/in-process-job-runner';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuilderService } from '../../../src/extensions/host/builder/service';
import { getWriterPidPath, readWriterLock, tryAcquireWriterLock } from '../../../src/mcp/writer-lock';

let root: string;
let dbPath: string;
let service: BuilderService | undefined;
let child: ChildProcess | undefined;

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
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vacuum-writer-')));
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
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => { child?.once('exit', () => resolve()); });
    child.kill();
    await exited;
  }
  child = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('vacuum after a no-op open with a writer', () => {
  it('leaves the database and another live writer record unchanged', async () => {
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1<<30)'], { stdio: 'ignore' });
    if (child.pid === undefined) throw new Error('child did not start');
    const pid = child.pid;
    const record = JSON.stringify({ pid, mode: 'watch', startedAt: Date.now() }) + '\n';
    fs.writeFileSync(getWriterPidPath(root), record);
    const lines: string[] = [];
    service = new BuilderService({ runJob: inProcessJobRunner().runJob,
      send: () => {}, jobLog: (line) => { lines.push(line); }, log: () => {}, housekeeping: false,
      vacuum: { minFreelistBytes: 65536 },
    });
    const beforeSize = fs.statSync(dbPath).size;
    const beforeFree = freelist();
    expect(beforeFree).toBeGreaterThan(16);
    await service.queue.enqueue('open', root, async () => null);
    await service.queue.whenRootIdle(root);
    await service.queue.whenIdle();
    expect(freelist()).toBe(beforeFree);
    expect(fs.statSync(dbPath).size).toBe(beforeSize);
    expect(lines.filter((line) => line.includes('vacuum skipped') && line.includes(root) && line.includes(String(pid)))).toHaveLength(1);
    expect(readWriterLock(root)?.pid).toBe(pid);
    expect(fs.readFileSync(getWriterPidPath(root), 'utf8')).toBe(record);
  });

  it('vacuums while retaining the same-process writer record', async () => {
    expect(tryAcquireWriterLock(root, 'builder').kind).toBe('acquired');
    const record = fs.readFileSync(getWriterPidPath(root), 'utf8');
    const lines: string[] = [];
    service = new BuilderService({ runJob: inProcessJobRunner().runJob,
      send: () => {}, jobLog: (line) => { lines.push(line); }, log: () => {}, housekeeping: false,
      vacuum: { minFreelistBytes: 65536 },
    });
    const beforeSize = fs.statSync(dbPath).size;
    expect(freelist()).toBeGreaterThan(16);
    await service.queue.enqueue('open', root, async () => null);
    await service.queue.whenRootIdle(root);
    await service.queue.whenIdle();
    expect(fs.statSync(dbPath).size).toBeLessThan(beforeSize);
    expect(freelist()).toBeLessThanOrEqual(1);
    expect(lines.some((line) => line.includes(`job end vacuum ${root} ok`))).toBe(true);
    expect(readWriterLock(root)?.pid).toBe(process.pid);
    expect(fs.readFileSync(getWriterPidPath(root), 'utf8')).toBe(record);
  });
});
