import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { JobSupervisor } from '../../../src/extensions/host/builder/job-supervisor';

const fixture = path.resolve(__dirname, 'fixtures/job-process-bodies.cjs');
const entry = path.resolve(__dirname, 'fixtures/job-process-entry.cjs');
const spec = (name: string) => ({ kind: 'sync' as const, root: '/root', module: fixture, export: name, args: null, writerPid: 123 });
const supervisor = new JobSupervisor({ entry, execArgv: [] });
afterEach(async () => { await supervisor.killAll(); });

describe('JobSupervisor', () => {
  it('delivers ordered progress and resolves the result', async () => {
    const progress: unknown[] = [];
    await expect(supervisor.run(1, spec('progress'), (payload) => { progress.push(payload); })).resolves.toEqual({ answer: 42 });
    expect(progress).toEqual(['first', 'second']);
  });

  it('rejects with the child error message', async () => {
    await expect(supervisor.run(2, spec('fail'))).rejects.toThrow('fixture failed');
  });

  it('preserves the child error name and message in its rejection', async () => {
    const job = { ...spec('fail'), module: path.resolve(__dirname, 'fixtures/named-error-job.cjs') };
    const rejection = supervisor.run(12, job);
    await expect(rejection).rejects.toBeInstanceOf(Error);
    await expect(rejection).rejects.toMatchObject({
      name: 'LockUnavailableError',
      message: 'lock is unavailable',
    });
  });

  it('rejects an exit without a result and names its code', async () => {
    await expect(supervisor.run(7, spec('exit'))).rejects.toThrow(/17/);
  });

  it('kills all running children', async () => {
    let firstReady: () => void = () => undefined;
    let secondReady: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => { firstReady = resolve; });
    const secondStarted = new Promise<void>((resolve) => { secondReady = resolve; });
    const first = expect(supervisor.run(8, spec('hold'), () => firstReady())).rejects.toThrow();
    const second = expect(supervisor.run(9, spec('hold'), () => secondReady())).rejects.toThrow();
    await Promise.all([firstStarted, secondStarted]);
    await supervisor.killAll();
    await Promise.all([first, second]);
    expect(supervisor.childPid(8)).toBeNull();
    expect(supervisor.childPid(9)).toBeNull();
  });

  it('kills only the requested child while another resolves', async () => {
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const killed = supervisor.run(3, spec('hold'), () => ready());
    const rejected = expect(killed).rejects.toThrow(/SIGKILL|signal|exit/i);
    await started;
    const other = supervisor.run(4, spec('progress'));
    await supervisor.kill(3);
    await rejected;
    await expect(other).resolves.toEqual({ answer: 42 });
  });

  it('exposes a live child pid only while the job runs', async () => {
    expect(supervisor.childPid(5)).toBeNull();
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const job = supervisor.run(5, spec('hold'), () => ready());
    const rejected = expect(job).rejects.toThrow();
    await started;
    const pid = supervisor.childPid(5);
    expect(pid).not.toBeNull();
    if (pid === null) throw new Error('no child pid');
    expect(() => process.kill(pid, 0)).not.toThrow();
    await supervisor.kill(5);
    await rejected;
    expect(supervisor.childPid(5)).toBeNull();
  });

  it('records a reported database identity', async () => {
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    expect(supervisor.createdDatabase(6)).toBeNull();
    const job = supervisor.run(6, spec('database'), () => ready());
    const rejected = expect(job).rejects.toThrow();
    await started;
    expect(supervisor.createdDatabase(6)).toBe('device:inode');
    await supervisor.kill(6);
    await rejected;
  });

  it('retains a killed child database identity for exactly one read after kill', async () => {
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const rejected = expect(supervisor.run(10, spec('database'), () => ready())).rejects.toThrow();
    await started;
    await supervisor.kill(10);
    expect(supervisor.createdDatabase(10)).toBe('device:inode');
    expect(supervisor.createdDatabase(10)).toBeNull();
    await rejected;
  });

  it('drops a database identity when the child returns a result', async () => {
    await expect(supervisor.run(11, spec('databaseResult'))).resolves.toEqual({ answer: 42 });
    expect(supervisor.createdDatabase(11)).toBeNull();
  });

  it('does not kill a running child when the requested pid differs', async () => {
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const rejected = expect(supervisor.run(13, spec('hold'), () => ready())).rejects.toThrow();
    await started;
    const pid = supervisor.childPid(13);
    if (pid === null) throw new Error('no child pid');
    try {
      await expect(supervisor.kill(13, pid + 1)).resolves.toBe(false);
      expect(supervisor.childPid(13)).toBe(pid);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      await supervisor.kill(13);
      await rejected;
    }
  });

  it('kills the matching child and resolves true after it closes', async () => {
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const rejected = expect(supervisor.run(14, spec('hold'), () => ready())).rejects.toThrow();
    await started;
    const pid = supervisor.childPid(14);
    if (pid === null) throw new Error('no child pid');
    try {
      await expect(supervisor.kill(14, pid)).resolves.toBe(true);
      expect(supervisor.childPid(14)).toBeNull();
    } finally {
      await supervisor.kill(14);
      await rejected;
    }
  });

  it('resolves true for an unknown id without a pid', async () => {
    await expect(supervisor.kill(999)).resolves.toBe(true);
  });

  it('resolves false for an unknown id with a pid', async () => {
    await expect(supervisor.kill(999, 101)).resolves.toBe(false);
  });
});
