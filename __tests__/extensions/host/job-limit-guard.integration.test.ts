import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { endOverLimit } from '../../../src/extensions/host/builder/job-limit-guard';

const breach = { limit: 'time' as const, maxMs: 3600000, measuredMs: 3600001 };
const at = '2026-11-16T10:00:00.000Z';
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

describe('endOverLimit', () => {
  it('logs, marks, rolls back the owned cold build and releases its locks before exiting', () => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.writeFileSync(path.join(dir, `codegraph.db${suffix}`), 'partial');
    lock('rebuild.pid', process.pid);
    lock('writer.pid', process.pid);
    const steps: string[] = [];
    endOverLimit({ kind: 'cold-build', root }, breach, {
      jobLog: (line) => { steps.push('log'); expect(line).toBe(`${at} job limit cold-build ${root} time 3600001 ms > 3600000 ms (CODEGRAPH_BUILDER_JOB_MAX_MS); ended, not retried`); },
      endedFile: { append: (mark) => { steps.push('mark'); expect(mark).toEqual({ root, kind: 'cold-build', limit: 'time', at }); } },
      beforeExit: () => {
        steps.push('beforeExit');
        for (const name of ['codegraph.db', 'codegraph.db-wal', 'codegraph.db-shm', 'codegraph.db-journal', 'rebuild.pid', 'writer.pid']) {
          expect(fs.existsSync(path.join(dir, name))).toBe(false);
        }
      },
      exit: (code) => { steps.push(`exit ${code}`); }, now: () => new Date(at), pid: process.pid,
    });
    expect(steps).toEqual(['log', 'mark', 'beforeExit', 'exit 75']);
  });

  it('preserves a database and locks owned by another pid', () => {
    fs.writeFileSync(path.join(dir, 'codegraph.db'), 'other');
    lock('rebuild.pid', process.ppid);
    lock('writer.pid', process.ppid);
    const exit = vi.fn();
    endOverLimit({ kind: 'cold-build', root }, breach, {
      jobLog: () => undefined, endedFile: { append: () => undefined }, beforeExit: () => undefined,
      exit, now: () => new Date(at), pid: process.pid,
    });
    expect(fs.readFileSync(path.join(dir, 'codegraph.db'), 'utf8')).toBe('other');
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'writer.pid'))).toBe(true);
    expect(exit).toHaveBeenCalledWith(75);
  });

  it('does not remove the database for a non-cold job', () => {
    fs.writeFileSync(path.join(dir, 'codegraph.db'), 'complete');
    lock('rebuild.pid', process.pid);
    const exit = vi.fn();
    endOverLimit({ kind: 'sync', root }, breach, {
      jobLog: () => undefined, endedFile: { append: () => undefined }, beforeExit: () => undefined,
      exit, now: () => new Date(at), pid: process.pid,
    });
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
