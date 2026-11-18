import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { statInode } from '../../../src/directory';
import { endOverLimit } from '../../../src/extensions/host/builder/job-limit-guard';
import { coldBuildDatabases } from '../../../src/extensions/host/worktree-lifecycle/cold-build-database';

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
afterEach(() => {
  coldBuildDatabases.clear(root);
  fs.rmSync(root, { recursive: true, force: true });
});

function lock(name: string, pid: number): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid, mode: 'cold-build', startedAt: 0 }));
}

function writeDatabase(content: string): void {
  for (const name of dbNames) fs.writeFileSync(path.join(dir, name), content);
}

function quietDeps(exit: (code: number) => void) {
  return { jobLog: () => undefined, endedFile: { append: () => undefined }, beforeExit: () => undefined, exit, now: () => new Date(at), pid: process.pid };
}

describe('endOverLimit', async () => {
  it.each(['', '-wal', '-shm', '-journal'])('removes the seed pid staging file%s on limit exit while preserving other files', async (suffix) => {
    const own = `codegraph.db.seed-123-0a1b2c3d.tmp${suffix}`;
    fs.writeFileSync(path.join(dir, own), 'own');
    fs.writeFileSync(path.join(dir, 'codegraph.db.seed-124-ab.tmp'), 'other');
    fs.writeFileSync(path.join(dir, 'codegraph.db'), 'database');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignore');
    const marks: unknown[] = [];
    const exit = vi.fn();
    await endOverLimit({ kind: 'seed', root }, breach, {
      ...quietDeps(exit), pid: 123, endedFile: { append: (mark) => { marks.push(mark); } },
    });
    expect(marks).toEqual([{ root, kind: 'seed', limit: 'time', at }]);
    expect(exit).toHaveBeenCalledWith(75);
    expect(fs.readFileSync(path.join(dir, 'codegraph.db.seed-124-ab.tmp'), 'utf8')).toBe('other');
    expect(fs.readFileSync(path.join(dir, 'codegraph.db'), 'utf8')).toBe('database');
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('ignore');
    expect(fs.existsSync(path.join(dir, own))).toBe(false);
  });

  it.each(['cold-build', 'sync'] as const)('preserves same-pid seed staging on a %s limit exit', async (kind) => {
    fs.writeFileSync(path.join(dir, 'codegraph.db.seed-123-0a1b2c3d.tmp'), 'staging');
    const exit = vi.fn();
    await endOverLimit({ kind, root }, breach, { ...quietDeps(exit), pid: 123 });
    expect(fs.readFileSync(path.join(dir, 'codegraph.db.seed-123-0a1b2c3d.tmp'), 'utf8')).toBe('staging');
    expect(exit).toHaveBeenCalledWith(75);
  });

  it('logs, marks, rolls back the cold build\'s own database and releases its locks before exiting', async () => {
    writeDatabase('partial');
    coldBuildDatabases.set(root, statInode(path.join(dir, 'codegraph.db')));
    lock('rebuild.pid', process.pid);
    lock('writer.pid', process.pid);
    const steps: string[] = [];
    const lines: string[] = [];
    const marks: unknown[] = [];
    let presentAtBeforeExit: string[] = [];
    await endOverLimit({ kind: 'cold-build', root }, breach, {
      jobLog: (line) => { steps.push('log'); lines.push(line); },
      endedFile: { append: (mark) => { steps.push('mark'); marks.push(mark); } },
      beforeExit: () => {
        steps.push('beforeExit');
        presentAtBeforeExit = [...dbNames, 'rebuild.pid', 'writer.pid'].filter((name) => fs.existsSync(path.join(dir, name)));
      },
      exit: (code) => { steps.push(`exit ${code}`); }, now: () => new Date(at), pid: process.pid,
    });
    expect(steps).toEqual(['log', 'mark', 'beforeExit', 'exit 75']);
    expect(lines).toEqual([`${at} job limit cold-build ${root} time 3600001 ms > 3600000 ms (CODEGRAPH_BUILDER_JOB_MAX_MS); ended, not retried`]);
    expect(marks).toEqual([{ root, kind: 'cold-build', limit: 'time', at }]);
    expect(presentAtBeforeExit).toEqual([]);
  });

  it('keeps a database under its rebuild.pid that is not registered as the cold build\'s own', async () => {
    writeDatabase('user init');
    lock('rebuild.pid', process.pid);
    const exit = vi.fn();
    await endOverLimit({ kind: 'cold-build', root }, breach, quietDeps(exit));
    for (const name of dbNames) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe('user init');
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(false);
    expect(exit).toHaveBeenCalledWith(75);
  });

  it('keeps a database that replaced the one the cold build registered', async () => {
    fs.writeFileSync(path.join(dir, 'codegraph.db'), 'build');
    coldBuildDatabases.set(root, statInode(path.join(dir, 'codegraph.db')));
    fs.renameSync(path.join(dir, 'codegraph.db'), path.join(root, 'moved.db'));
    fs.writeFileSync(path.join(dir, 'codegraph.db'), 'user init');
    lock('rebuild.pid', process.pid);
    const exit = vi.fn();
    await endOverLimit({ kind: 'cold-build', root }, breach, quietDeps(exit));
    expect(fs.readFileSync(path.join(dir, 'codegraph.db'), 'utf8')).toBe('user init');
    expect(exit).toHaveBeenCalledWith(75);
  });

  it('preserves a registered database and locks owned by another pid', async () => {
    fs.writeFileSync(path.join(dir, 'codegraph.db'), 'other');
    coldBuildDatabases.set(root, statInode(path.join(dir, 'codegraph.db')));
    lock('rebuild.pid', process.ppid);
    lock('writer.pid', process.ppid);
    const exit = vi.fn();
    await endOverLimit({ kind: 'cold-build', root }, breach, quietDeps(exit));
    expect(fs.readFileSync(path.join(dir, 'codegraph.db'), 'utf8')).toBe('other');
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'writer.pid'))).toBe(true);
    expect(exit).toHaveBeenCalledWith(75);
  });

  it('does not remove the database for a non-cold job', async () => {
    fs.writeFileSync(path.join(dir, 'codegraph.db'), 'complete');
    coldBuildDatabases.set(root, statInode(path.join(dir, 'codegraph.db')));
    lock('rebuild.pid', process.pid);
    const exit = vi.fn();
    await endOverLimit({ kind: 'sync', root }, breach, quietDeps(exit));
    expect(fs.readFileSync(path.join(dir, 'codegraph.db'), 'utf8')).toBe('complete');
    expect(exit).toHaveBeenCalledWith(75);
  });

  it('logs each alongside failure after the limit line, marks only the breached job, then exits', async () => {
    const lines: string[] = [];
    const steps: string[] = [];
    const append = vi.fn(() => { steps.push('mark'); });
    const beforeExit = vi.fn(() => { steps.push('beforeExit'); });
    const exit = vi.fn((code: number) => { steps.push(`exit ${code}`); });
    await endOverLimit({ kind: 'sync', root: '/over' }, breach, {
      jobLog: (line) => { lines.push(line); steps.push('log'); },
      endedFile: { append }, beforeExit, exit, now: () => new Date(at), pid: process.pid,
      alongside: [{ kind: 'seed', root }, { kind: 'index', root: '/other' }],
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`${at} job limit sync /over time 3600001 ms > 3600000 ms (CODEGRAPH_BUILDER_JOB_MAX_MS); ended, not retried`);
    expect(lines[1]).toContain(`job end seed ${root} failed: `);
    expect(lines[2]).toContain('job end index /other failed: ');
    for (const line of lines.slice(1)) {
      expect(line).toContain('sync');
      expect(line).toContain('/over');
      expect(line).toContain('time');
    }
    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith({ root: '/over', kind: 'sync', limit: 'time', at });
    expect(beforeExit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(75);
    expect(steps.slice(-2)).toEqual(['beforeExit', 'exit 75']);
  });

  it('rolls back an alongside cold build and releases its own locks before exit', async () => {
    writeDatabase('partial');
    coldBuildDatabases.set(root, statInode(path.join(dir, 'codegraph.db')));
    lock('rebuild.pid', process.pid);
    lock('writer.pid', process.pid);
    let presentAtExit: string[] = [];
    const exit = vi.fn();
    await endOverLimit({ kind: 'sync', root: '/over' }, breach, {
      ...quietDeps(exit), alongside: [{ kind: 'cold-build', root }],
      beforeExit: () => { presentAtExit = [...dbNames, 'rebuild.pid', 'writer.pid'].filter((name) => fs.existsSync(path.join(dir, name))); },
    });
    expect(presentAtExit).toEqual([]);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(75);
  });

  it('keeps an alongside cold database and locks owned by another pid', async () => {
    writeDatabase('other');
    coldBuildDatabases.set(root, statInode(path.join(dir, 'codegraph.db')));
    lock('rebuild.pid', process.ppid);
    lock('writer.pid', process.ppid);
    const lines: string[] = [];
    await endOverLimit({ kind: 'sync', root: '/over' }, breach, {
      ...quietDeps(vi.fn()), jobLog: (line) => { lines.push(line); }, alongside: [{ kind: 'cold-build', root }],
    });
    expect(lines).toHaveLength(2);
    for (const name of dbNames) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe('other');
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'writer.pid'))).toBe(true);
  });

  it('keeps an unregistered alongside cold database while removing its own locks', async () => {
    writeDatabase('user init');
    lock('rebuild.pid', process.pid);
    lock('writer.pid', process.pid);
    await endOverLimit({ kind: 'sync', root: '/over' }, breach, {
      ...quietDeps(vi.fn()), alongside: [{ kind: 'cold-build', root }],
    });
    for (const name of dbNames) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe('user init');
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'writer.pid'))).toBe(false);
  });

  it('removes an alongside seed staging copies and its locks but preserves other pids', async () => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.writeFileSync(path.join(dir, `codegraph.db.seed-123-0a1b2c3d.tmp${suffix}`), 'own');
    fs.writeFileSync(path.join(dir, 'codegraph.db.seed-124-ab.tmp'), 'other');
    lock('rebuild.pid', 123);
    lock('writer.pid', 124);
    await endOverLimit({ kind: 'sync', root: '/over' }, breach, {
      ...quietDeps(vi.fn()), pid: 123, alongside: [{ kind: 'seed', root }],
    });
    for (const suffix of ['', '-wal', '-shm', '-journal']) expect(fs.existsSync(path.join(dir, `codegraph.db.seed-123-0a1b2c3d.tmp${suffix}`))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'codegraph.db.seed-124-ab.tmp'), 'utf8')).toBe('other');
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'writer.pid'))).toBe(true);
  });

  it.each(['index', 'init'] as const)('does not roll back an alongside %s database', async (kind) => {
    writeDatabase('complete');
    coldBuildDatabases.set(root, statInode(path.join(dir, 'codegraph.db')));
    lock('rebuild.pid', process.pid);
    lock('writer.pid', process.pid);
    await endOverLimit({ kind: 'sync', root: '/over' }, breach, {
      ...quietDeps(vi.fn()), alongside: [{ kind, root }],
    });
    for (const name of dbNames) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe('complete');
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'writer.pid'))).toBe(false);
  });

  it.each(['log', 'append'] as const)('still exits when %s throws', async (which) => {
    const beforeExit = vi.fn();
    const exit = vi.fn();
    const append = vi.fn(() => { if (which === 'append') throw new Error('append failed'); });
    await endOverLimit({ kind: 'sync', root }, breach, {
      jobLog: () => { if (which === 'log') throw new Error('log failed'); },
      endedFile: { append }, beforeExit, exit, now: () => new Date(at), pid: process.pid,
    });
    expect(append).toHaveBeenCalledOnce();
    expect(beforeExit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(75);
  });
  it("kills first, keeps the hold's writer lock naming the builder, removes child rebuild lock and does not end alongside jobs", async () => {
    lock('rebuild.pid', 123);
    lock('writer.pid', 456);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const exit = vi.fn();
    const beforeExit = vi.fn();
    const jobLog = vi.fn();
    const append = vi.fn();
    const deps = { ...quietDeps(exit), pid: 456, beforeExit, jobLog, endedFile: { append },
      alongside: [{ kind: 'sync' as const, root: '/other' }],
      child: { pid: 123, createdDatabase: null, kill: () => gate } };
    const ending = endOverLimit({ kind: 'sync', root }, breach, deps);
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(true);
    expect(jobLog).not.toHaveBeenCalled();
    release();
    await ending;
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'writer.pid'))).toBe(true);
    expect(jobLog).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledOnce();
    expect(beforeExit).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('removes a child-owned writer lock', async () => {
    lock('writer.pid', 123);
    const deps = { ...quietDeps(vi.fn()), pid: 456,
      child: { pid: 123, createdDatabase: null, kill: async () => undefined } };
    await endOverLimit({ kind: 'sync', root }, breach, deps);
    expect(fs.existsSync(path.join(dir, 'writer.pid'))).toBe(false);
  });

  it.each(['match', 'mismatch', 'null'] as const)('child cold database identity %s controls rollback', async (identity) => {
    writeDatabase('partial');
    lock('rebuild.pid', 123);
    const createdDatabase = identity === 'match' ? statInode(path.join(dir, 'codegraph.db')) : identity === 'mismatch' ? 'different' : null;
    const deps = { ...quietDeps(vi.fn()), pid: 456,
      child: { pid: 123, createdDatabase, kill: async () => undefined } };
    await endOverLimit({ kind: 'cold-build', root }, breach, deps);
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(false);
    expect(deps.exit).not.toHaveBeenCalled();
    for (const name of dbNames) expect(fs.existsSync(path.join(dir, name))).toBe(identity !== 'match');
  });

  it('removes only seed staging files owned by the child', async () => {
    fs.writeFileSync(path.join(dir, 'codegraph.db.seed-123-0a1b2c3d.tmp'), 'child');
    fs.writeFileSync(path.join(dir, 'codegraph.db.seed-456-0a1b2c3d.tmp'), 'builder');
    const deps = { ...quietDeps(vi.fn()), pid: 456,
      child: { pid: 123, createdDatabase: null, kill: async () => undefined } };
    await endOverLimit({ kind: 'seed', root }, breach, deps);
    expect(fs.existsSync(path.join(dir, 'codegraph.db.seed-123-0a1b2c3d.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'codegraph.db.seed-456-0a1b2c3d.tmp'))).toBe(true);
  });

  it('awaits killAll before cleanup and exit without a child', async () => {
    lock('writer.pid', 123);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const exit = vi.fn();
    const deps = { ...quietDeps(exit), pid: 123, killAll: () => gate };
    const ending = endOverLimit({ kind: 'sync', root }, breach, deps);
    expect(fs.existsSync(path.join(dir, 'writer.pid'))).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    release();
    await ending;
    expect(fs.existsSync(path.join(dir, 'writer.pid'))).toBe(false);
    expect(exit).toHaveBeenCalledWith(75);
  });

});
