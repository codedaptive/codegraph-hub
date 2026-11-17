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

describe('endOverLimit', () => {
  it.each(['', '-wal', '-shm', '-journal'])('removes the seed pid staging file%s on limit exit while preserving other files', (suffix) => {
    const own = `codegraph.db.seed-123-0a1b2c3d.tmp${suffix}`;
    fs.writeFileSync(path.join(dir, own), 'own');
    fs.writeFileSync(path.join(dir, 'codegraph.db.seed-124-ab.tmp'), 'other');
    fs.writeFileSync(path.join(dir, 'codegraph.db'), 'database');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignore');
    const marks: unknown[] = [];
    const exit = vi.fn();
    endOverLimit({ kind: 'seed', root }, breach, {
      ...quietDeps(exit), pid: 123, endedFile: { append: (mark) => { marks.push(mark); } },
    });
    expect(marks).toEqual([{ root, kind: 'seed', limit: 'time', at }]);
    expect(exit).toHaveBeenCalledWith(75);
    expect(fs.readFileSync(path.join(dir, 'codegraph.db.seed-124-ab.tmp'), 'utf8')).toBe('other');
    expect(fs.readFileSync(path.join(dir, 'codegraph.db'), 'utf8')).toBe('database');
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('ignore');
    expect(fs.existsSync(path.join(dir, own))).toBe(false);
  });

  it.each(['cold-build', 'sync'] as const)('preserves same-pid seed staging on a %s limit exit', (kind) => {
    fs.writeFileSync(path.join(dir, 'codegraph.db.seed-123-0a1b2c3d.tmp'), 'staging');
    const exit = vi.fn();
    endOverLimit({ kind, root }, breach, { ...quietDeps(exit), pid: 123 });
    expect(fs.readFileSync(path.join(dir, 'codegraph.db.seed-123-0a1b2c3d.tmp'), 'utf8')).toBe('staging');
    expect(exit).toHaveBeenCalledWith(75);
  });

  it('logs, marks, rolls back the cold build\'s own database and releases its locks before exiting', () => {
    writeDatabase('partial');
    coldBuildDatabases.set(root, statInode(path.join(dir, 'codegraph.db')));
    lock('rebuild.pid', process.pid);
    lock('writer.pid', process.pid);
    const steps: string[] = [];
    const lines: string[] = [];
    const marks: unknown[] = [];
    let presentAtBeforeExit: string[] = [];
    endOverLimit({ kind: 'cold-build', root }, breach, {
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

  it('keeps a database under its rebuild.pid that is not registered as the cold build\'s own', () => {
    writeDatabase('user init');
    lock('rebuild.pid', process.pid);
    const exit = vi.fn();
    endOverLimit({ kind: 'cold-build', root }, breach, quietDeps(exit));
    for (const name of dbNames) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe('user init');
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(false);
    expect(exit).toHaveBeenCalledWith(75);
  });

  it('keeps a database that replaced the one the cold build registered', () => {
    fs.writeFileSync(path.join(dir, 'codegraph.db'), 'build');
    coldBuildDatabases.set(root, statInode(path.join(dir, 'codegraph.db')));
    fs.renameSync(path.join(dir, 'codegraph.db'), path.join(root, 'moved.db'));
    fs.writeFileSync(path.join(dir, 'codegraph.db'), 'user init');
    lock('rebuild.pid', process.pid);
    const exit = vi.fn();
    endOverLimit({ kind: 'cold-build', root }, breach, quietDeps(exit));
    expect(fs.readFileSync(path.join(dir, 'codegraph.db'), 'utf8')).toBe('user init');
    expect(exit).toHaveBeenCalledWith(75);
  });

  it('preserves a registered database and locks owned by another pid', () => {
    fs.writeFileSync(path.join(dir, 'codegraph.db'), 'other');
    coldBuildDatabases.set(root, statInode(path.join(dir, 'codegraph.db')));
    lock('rebuild.pid', process.ppid);
    lock('writer.pid', process.ppid);
    const exit = vi.fn();
    endOverLimit({ kind: 'cold-build', root }, breach, quietDeps(exit));
    expect(fs.readFileSync(path.join(dir, 'codegraph.db'), 'utf8')).toBe('other');
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'writer.pid'))).toBe(true);
    expect(exit).toHaveBeenCalledWith(75);
  });

  it('does not remove the database for a non-cold job', () => {
    fs.writeFileSync(path.join(dir, 'codegraph.db'), 'complete');
    coldBuildDatabases.set(root, statInode(path.join(dir, 'codegraph.db')));
    lock('rebuild.pid', process.pid);
    const exit = vi.fn();
    endOverLimit({ kind: 'sync', root }, breach, quietDeps(exit));
    expect(fs.readFileSync(path.join(dir, 'codegraph.db'), 'utf8')).toBe('complete');
    expect(exit).toHaveBeenCalledWith(75);
  });

  it.each(['log', 'append'] as const)('still exits when %s throws', (which) => {
    const beforeExit = vi.fn();
    const exit = vi.fn();
    const append = vi.fn(() => { if (which === 'append') throw new Error('append failed'); });
    endOverLimit({ kind: 'sync', root }, breach, {
      jobLog: () => { if (which === 'log') throw new Error('log failed'); },
      endedFile: { append }, beforeExit, exit, now: () => new Date(at), pid: process.pid,
    });
    expect(append).toHaveBeenCalledOnce();
    expect(beforeExit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(75);
  });
});
