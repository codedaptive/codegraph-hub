import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuilderService } from '../../../src/extensions/host/builder/service';
import { getWriterPidPath, readWriterLock, tryAcquireWriterLock } from '../../../src/mcp/writer-lock';
import { testJobSupervisor } from './helpers/test-job-supervisor';

let root: string;
let dbPath: string;
let service: BuilderService | undefined;
let writer: ChildProcess | undefined;
const supervisor = testJobSupervisor();

function freelist(): number {
  const db = new DatabaseSync(dbPath);
  try {
    const value = db.prepare('PRAGMA freelist_count').get()?.freelist_count;
    if (typeof value !== 'number') throw new Error('missing freelist count');
    return value;
  } finally { db.close(); }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vacuum-child-')));
  execFileSync('git', ['init', '-q', root]);
  fs.mkdirSync(path.join(root, '.codegraph'));
  dbPath = path.join(root, '.codegraph', 'codegraph.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE payload (data BLOB); BEGIN;');
    const insert = db.prepare('INSERT INTO payload VALUES (zeroblob(4096))');
    for (let i = 0; i < 256; i++) insert.run();
    db.exec('COMMIT; DELETE FROM payload; PRAGMA wal_checkpoint(TRUNCATE);');
  } finally { db.close(); }
});

afterEach(async () => {
  await service?.stop(1000);
  service = undefined;
  await supervisor.killAll();
  if (writer && writer.exitCode === null && writer.signalCode === null) {
    const exited = new Promise<void>((resolve) => { writer?.once('exit', () => resolve()); });
    writer.kill();
    await exited;
  }
  writer = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('vacuum in a child', { timeout: 90_000 }, () => {
  it('vacuums under the builder hold without replacing its writer record', async () => {
    expect(tryAcquireWriterLock(root, 'builder').kind).toBe('acquired');
    const record = fs.readFileSync(getWriterPidPath(root), 'utf8');
    const pids: number[] = [];
    service = new BuilderService({
      runJob: (id, spec, progress) => {
        const result = supervisor.run(id, spec, progress);
        const pid = supervisor.childPid(id);
        if (spec.kind === 'vacuum' && pid !== null) pids.push(pid);
        return result;
      },
      send: () => {}, jobLog: () => {}, log: () => {}, watchOptions: () => ({}), housekeeping: false,
      vacuum: { minFreelistBytes: 65536 },
    });
    expect(freelist()).toBeGreaterThan(16);
    await service.queue.enqueue('open', root, async () => null);
    await service.queue.whenIdle();
    expect(pids).toHaveLength(1);
    expect(pids[0]).not.toBe(process.pid);
    expect(freelist()).toBeLessThanOrEqual(1);
    expect(readWriterLock(root)?.pid).toBe(process.pid);
    expect(fs.readFileSync(getWriterPidPath(root), 'utf8')).toBe(record);
  });

  it('reports a live other writer from the child and leaves the database untouched', async () => {
    writer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1<<30)'], { stdio: 'ignore' });
    if (writer.pid === undefined) throw new Error('writer did not start');
    const pid = writer.pid;
    const record = JSON.stringify({ pid, mode: 'watch', startedAt: 1 }) + '\n';
    fs.writeFileSync(getWriterPidPath(root), record);
    const lines: string[] = [];
    const pids: number[] = [];
    service = new BuilderService({
      runJob: (id, spec, progress) => {
        const result = supervisor.run(id, spec, progress);
        const childPid = supervisor.childPid(id);
        if (spec.kind === 'vacuum' && childPid !== null) pids.push(childPid);
        return result;
      },
      send: () => {}, jobLog: (line) => { lines.push(line); }, log: () => {}, watchOptions: () => ({}), housekeeping: false,
      vacuum: { minFreelistBytes: 65536 },
    });
    const before = freelist();
    expect(before).toBeGreaterThan(16);
    await service.queue.enqueue('open', root, async () => null);
    await service.queue.whenIdle();
    expect(pids).toHaveLength(1);
    expect(freelist()).toBe(before);
    expect(lines.filter((line) => line.includes('vacuum skipped') && line.includes(root) && line.includes(String(pid)))).toHaveLength(1);
    expect(fs.readFileSync(getWriterPidPath(root), 'utf8')).toBe(record);
  });
});
