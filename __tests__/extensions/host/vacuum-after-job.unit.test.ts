import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { JobEvent, JobKind, EnqueueOptions } from '../../../src/extensions/host/builder/queue';
import { vacuumAfterJob } from '../../../src/extensions/host/builder/vacuum-after-job';

vi.mock('../../../src/directory', () => ({
  getCodeGraphDir: (root: string) => `${root}/.codegraph`,
  canonicalProjectRoot: () => '/canonical/project',
}));
vi.mock('../../../src/extensions/host/builder/take-vacuum-writer-slot', () => ({
  takeVacuumWriterSlot: () => ({ kind: 'held', release: () => {} }),
}));
vi.mock('../../../src/extensions/host/builder/free-disk-bytes', () => ({ freeDiskBytes: () => 3_000_000_000 }));
vi.mock('../../../src/extensions/host/builder/run-vacuum-off-thread', () => ({ runVacuumOffThread: async () => {} }));

const root = '/project';
const dbPath = path.join(root, '.codegraph', 'codegraph.db');
const end = { edge: 'end', kind: 'sync', root, ok: true } as const;
const large = { pageSize: 4096, pageCount: 200000, freelistCount: 65536 };

function setup() {
  const jobs: { kind: JobKind; root: string; body: (job: { id: number }) => Promise<unknown>; options?: EnqueueOptions }[] = [];
  const enqueue = <T>(kind: JobKind, jobRoot: string, body: (job: { id: number }) => Promise<T>, options?: EnqueueOptions): Promise<T> => {
    jobs.push({ kind, root: jobRoot, body, options });
    return new Promise<T>(() => {});
  };
  const deps = {
    queue: { enqueue },
    runJob: vi.fn(async (_id: number, _spec: unknown, _progress?: (payload: unknown) => void): Promise<unknown> => 'vacuum'),
    minFreelistBytes: 10000,
    jobLog: vi.fn((_line: string) => {}),
    rebuildHeld: vi.fn(() => false),
    readStats: vi.fn((): typeof large | null => large),
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
  it('runs an unfenced vacuum in a child with the root and database arguments', async () => {
    const { jobs, deps } = setup();
    vacuumAfterJob(end, deps);
    expect(await jobs[0].body({ id: 7 })).toBe('vacuum');
    expect(deps.runJob).toHaveBeenCalledOnce();
    expect(deps.runJob.mock.calls[0][0]).toBe(7);
    expect(deps.runJob.mock.calls[0][1]).toMatchObject({ kind: 'vacuum', root, args: { root, dbPath, minFreelistBytes: 10000 } });
  });
  it('fences a queued body without running a child', async () => {
    const { jobs, deps } = setup();
    vacuumAfterJob(end, deps);
    deps.rebuildHeld.mockReturnValue(true);
    expect(await jobs[0].body({ id: 7 })).toBe('fenced');
    expect(deps.rebuildHeld).toHaveBeenCalledWith(root);
    expect(deps.runJob).not.toHaveBeenCalled();
  });
  it('forwards a child log progress line to jobLog', async () => {
    const { jobs, deps } = setup();
    deps.runJob.mockImplementation(async (_id, _spec, progress) => { progress?.({ log: 'vacuum skipped: writer held' }); return 'writer-held'; });
    vacuumAfterJob(end, deps);
    expect(await jobs[0].body({ id: 7 })).toBe('writer-held');
    expect(deps.jobLog).toHaveBeenCalledExactlyOnceWith('vacuum skipped: writer held');
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
