import { describe, expect, it, vi } from 'vitest';
import type { JobEvent, JobKind, EnqueueOptions } from '../../../src/extensions/host/builder/queue';
import { vacuumAfterJob } from '../../../src/extensions/host/builder/vacuum-after-job';

vi.mock('../../../src/directory', () => ({
  getCodeGraphDir: (root: string) => `${root}/.codegraph`,
  canonicalProjectRoot: () => '/canonical/project',
}));

const root = '/project';
const dbPath = '/project/.codegraph/codegraph.db';
const end = { edge: 'end', kind: 'sync', root, ok: true } as const;
const large = { pageSize: 4096, pageCount: 200000, freelistCount: 65536 };

function setup() {
  const jobs: { kind: JobKind; root: string; body: () => Promise<unknown>; options?: EnqueueOptions }[] = [];
  const enqueue = <T>(kind: JobKind, jobRoot: string, body: () => Promise<T>, options?: EnqueueOptions): Promise<T> => {
    jobs.push({ kind, root: jobRoot, body, options });
    return new Promise<T>(() => {});
  };
  const deps = {
    queue: { enqueue },
    jobLog: vi.fn((_line: string) => {}),
    rebuildHeld: vi.fn(() => false),
    readStats: vi.fn((): typeof large | null => large),
    freeDisk: vi.fn((): number | null => 3_000_000_000),
    runVacuum: vi.fn(async (_path: string) => {}),
  };
  return { jobs, deps };
}

describe('vacuumAfterJob', () => {
  it('queues exactly one coalesced vacuum of the completed root', () => {
    const { jobs, deps } = setup();
    vacuumAfterJob(end, deps);
    expect(deps.readStats).toHaveBeenCalledExactlyOnceWith(dbPath);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'vacuum', root, options: { coalesceKey: 'vacuum:/canonical/project' } });
  });
  it.each<JobEvent>([
    { edge: 'start', kind: 'sync', root },
    { edge: 'end', kind: 'sync', root, ok: false },
    { edge: 'end', kind: 'vacuum', root, ok: true },
  ])('ignores non-success or vacuum event $edge $kind', (event) => {
    const { jobs, deps } = setup();
    vacuumAfterJob(event, deps);
    expect(jobs).toHaveLength(0);
    expect(deps.readStats).not.toHaveBeenCalled();
  });
  it.each([null, { pageSize: 4096, pageCount: 200000, freelistCount: 1 }])('does not queue for absent or small statistics', (value) => {
    const { jobs, deps } = setup();
    deps.readStats.mockReturnValue(value);
    vacuumAfterJob(end, deps);
    expect(jobs).toHaveLength(0);
  });
  it('fences a queued body before re-reading stats or checking disk', async () => {
    const { jobs, deps } = setup();
    vacuumAfterJob(end, deps);
    deps.rebuildHeld.mockReturnValue(true);
    expect(await jobs[0].body()).toBe('fenced');
    expect(deps.rebuildHeld).toHaveBeenCalledWith(root);
    expect(deps.readStats).toHaveBeenCalledTimes(1);
    expect(deps.freeDisk).not.toHaveBeenCalled();
    expect(deps.runVacuum).not.toHaveBeenCalled();
  });
  it('logs one skip and does not vacuum when disk is short', async () => {
    const { jobs, deps } = setup();
    vacuumAfterJob(end, deps);
    deps.freeDisk.mockReturnValue(0);
    expect(await jobs[0].body()).toBe('disk-short');
    expect(deps.freeDisk).toHaveBeenCalledExactlyOnceWith('/project/.codegraph');
    expect(deps.jobLog).toHaveBeenCalledTimes(1);
    expect(deps.jobLog.mock.calls[0][0]).toContain('vacuum skipped');
    expect(deps.jobLog.mock.calls[0][0]).toContain(root);
    expect(deps.runVacuum).not.toHaveBeenCalled();
  });
  it('rechecks the freelist before running', async () => {
    const { jobs, deps } = setup();
    vacuumAfterJob(end, deps);
    deps.readStats.mockReturnValue({ pageSize: 4096, pageCount: 200000, freelistCount: 1 });
    expect(await jobs[0].body()).toBe('freelist-small');
    expect(deps.runVacuum).not.toHaveBeenCalled();
  });
  it('vacuum awaits the operation on the database with ample disk', async () => {
    const { jobs, deps } = setup();
    vacuumAfterJob(end, deps);
    expect(await jobs[0].body()).toBe('vacuum');
    expect(deps.readStats).toHaveBeenCalledTimes(2);
    expect(deps.runVacuum).toHaveBeenCalledExactlyOnceWith(dbPath);
  });
  it('swallows a throwing stats reader', () => {
    const { deps } = setup();
    deps.readStats.mockImplementation(() => { throw new Error('read failed'); });
    expect(() => vacuumAfterJob(end, deps)).not.toThrow();
  });
  it('swallows a throwing enqueue', () => {
    const { deps } = setup();
    deps.queue.enqueue = () => { throw new Error('closed'); };
    expect(() => vacuumAfterJob(end, deps)).not.toThrow();
  });
  it('handles a rejected enqueue without an unhandled rejection', async () => {
    const { deps } = setup();
    deps.queue.enqueue = () => Promise.reject(new Error('closed'));
    expect(() => vacuumAfterJob(end, deps)).not.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
