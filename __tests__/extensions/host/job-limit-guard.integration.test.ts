import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { statInode } from '../../../src/directory';
import { endOverLimit } from '../../../src/extensions/host/builder/job-limit-guard';
import { testJobSupervisor } from './helpers/test-job-supervisor';

const breach = { limit: 'time' as const, maxMs: 3600000, measuredMs: 3600001 };
const at = '2026-11-16T10:00:00.000Z';
const dbNames = ['codegraph.db', 'codegraph.db-wal', 'codegraph.db-shm', 'codegraph.db-journal'];
let root: string;
let dir: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-guard-')));
  dir = path.join(root, '.codegraph');
  fs.mkdirSync(dir);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function lock(name: string, pid: number): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid, mode: 'cold-build', startedAt: 0 }));
}
function deps(pid: number, createdDatabase: string | null, kill: () => Promise<boolean>) {
  return { jobLog: vi.fn(), endedFile: { append: vi.fn() }, now: () => new Date(at), child: { pid, createdDatabase, kill } };
}

describe('endOverLimit with a child', () => {
  it('leaves the job unmarked and its files intact when the child was not killed', async () => {
    for (const name of dbNames) fs.writeFileSync(path.join(dir, name), 'partial');
    lock('rebuild.pid', 123);
    const options = deps(123, statInode(path.join(dir, 'codegraph.db')), async () => false);
    await endOverLimit({ kind: 'cold-build', root }, breach, options);
    expect(options.jobLog).not.toHaveBeenCalled();
    expect(options.endedFile.append).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(true);
    for (const name of dbNames) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe('partial');
  });

  it("kills first, keeps the hold's writer lock and removes the child's rebuild lock", async () => {
    lock('rebuild.pid', 123);
    lock('writer.pid', 456);
    let release: (killed: boolean) => void = () => undefined;
    const gate = new Promise<boolean>((resolve) => { release = resolve; });
    const options = deps(123, null, () => gate);
    const ending = endOverLimit({ kind: 'sync', root }, breach, options);
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(true);
    expect(options.jobLog).not.toHaveBeenCalled();
    release(true);
    await ending;
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'writer.pid'))).toBe(true);
    expect(options.jobLog).toHaveBeenCalledOnce();
    expect(options.endedFile.append).toHaveBeenCalledExactlyOnceWith({ root, kind: 'sync', limit: 'time', at });
  });
  it('removes a child-owned writer lock', async () => {
    lock('writer.pid', 123);
    await endOverLimit({ kind: 'sync', root }, breach, deps(123, null, async () => true));
    expect(fs.existsSync(path.join(dir, 'writer.pid'))).toBe(false);
  });
  it.each(['match', 'mismatch', 'null'] as const)('child cold database identity %s controls rollback', async (identity) => {
    for (const name of dbNames) fs.writeFileSync(path.join(dir, name), 'partial');
    lock('rebuild.pid', 123);
    const createdDatabase = identity === 'match' ? statInode(path.join(dir, 'codegraph.db')) : identity === 'mismatch' ? 'different' : null;
    await endOverLimit({ kind: 'cold-build', root }, breach, deps(123, createdDatabase, async () => true));
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(false);
    for (const name of dbNames) expect(fs.existsSync(path.join(dir, name))).toBe(identity === 'mismatch');
  });
  it.each(['init', 'index'] as const)('keeps a user database when a %s child is ended, with or without a reported identity', async (kind) => {
    for (const name of dbNames) fs.writeFileSync(path.join(dir, name), 'user data');
    lock('rebuild.pid', 123);
    const identity = statInode(path.join(dir, 'codegraph.db'));
    // statInode reports no identity on win32 (src/directory.ts); an init or index end keeps the database either way.
    expect(identity === null).toBe(process.platform === 'win32');
    await endOverLimit({ kind, root }, breach, deps(123, identity, async () => true));
    for (const name of dbNames) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe('user data');
  });

  it('removes only seed staging files owned by the child', async () => {
    fs.writeFileSync(path.join(dir, 'codegraph.db.seed-123-0a1b2c3d.tmp'), 'child');
    fs.writeFileSync(path.join(dir, 'codegraph.db.seed-456-0a1b2c3d.tmp'), 'builder');
    await endOverLimit({ kind: 'seed', root }, breach, deps(123, null, async () => true));
    expect(fs.existsSync(path.join(dir, 'codegraph.db.seed-123-0a1b2c3d.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'codegraph.db.seed-456-0a1b2c3d.tmp'))).toBe(true);
  });
});

describe('endOverLimit with a real supervisor', { timeout: 90_000 }, () => {
  const supervisor = testJobSupervisor();
  const returning = path.resolve(__dirname, 'fixtures/job-process-bodies.cjs');
  const hanging = path.resolve(__dirname, 'fixtures/hanging-leftovers.cjs');
  const spec = (module: string, name: string) =>
    ({ kind: 'cold-build' as const, root, module, export: name, args: { root }, writerPid: process.pid });

  it('leaves a job that moved to a new child running, unmarked and with its files', async () => {
    const first = supervisor.run(1, spec(returning, 'progress'));
    const childA = supervisor.childPid(1);
    if (childA === null) throw new Error('first run has no child');
    await expect(first).resolves.toEqual({ answer: 42 });
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const second = supervisor.run(1, spec(hanging, 'coldBuild'), () => ready());
    const rejected = expect(second).rejects.toThrow();
    try {
      await Promise.race([started, second.then(() => { throw new Error('fixture returned'); })]);
      const childB = supervisor.childPid(1);
      expect(childB).not.toBeNull();
      expect(childB).not.toBe(childA);
      const options = { jobLog: vi.fn(), endedFile: { append: vi.fn() }, now: () => new Date(at),
        child: { pid: childA, createdDatabase: null, kill: () => supervisor.kill(1, childA) } };
      await endOverLimit({ kind: 'cold-build', root }, breach, options);
      expect(options.jobLog).not.toHaveBeenCalled();
      expect(options.endedFile.append).not.toHaveBeenCalled();
      expect(supervisor.childPid(1)).toBe(childB);
      expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(true);
      for (const name of dbNames) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe('partial build');
    } finally {
      await supervisor.kill(1);
      await rejected;
    }
  });
});
