import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { JobSupervisor } from '../../../src/extensions/host/builder/job-supervisor';

const fixture = path.resolve(__dirname, '../../fixtures/job-process-bodies.cjs');
const entry = path.resolve(__dirname, '../../fixtures/job-process-entry.cjs');
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

  it('resolves a kill for an unknown id', async () => {
    await expect(supervisor.kill(999)).resolves.toBeUndefined();
  });
});
