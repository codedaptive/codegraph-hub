/**
 * The index builder's queue against the process's real ended-jobs marks (./ended-jobs.ts, module state shared
 * by every queue in the process): an enqueue of an ended (root, kind) is refused, and a successful `init` or
 * `index` clears its root's marks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/directory', () => ({ canonicalProjectRoot: (root: string) => root }));
import { endedJobs } from '../../../src/extensions/host/builder/ended-jobs';
import { JobEndedError } from '../../../src/extensions/host/builder/job-ended-error';
import { JobQueue } from '../../../src/extensions/host/builder/queue';
import { recordingQueue } from './helpers/recording-queue';

describe('JobQueue job limits', () => {
  const mark = { root: '/ended', kind: 'sync' as const, limit: 'time' as const, at: '2026-11-16T10:00:00.000Z' };
  beforeEach(() => endedJobs.replaceAll([]));
  afterEach(() => endedJobs.replaceAll([]));

  it('rejects an ended job without running it or emitting events', async () => {
    endedJobs.add(mark);
    const { queue, events } = recordingQueue();
    const run = vi.fn(async () => 42);
    const result = queue.enqueue('sync', '/ended', run);
    await expect(result).rejects.toBeInstanceOf(JobEndedError);
    await expect(result).rejects.toMatchObject({ root: '/ended', kind: 'sync', limit: 'time' });
    expect(run).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('refuses a vacuum of a root whose vacuum was ended, until an index of that root ends ok', async () => {
    endedJobs.add({ ...mark, kind: 'vacuum' });
    const run = vi.fn(async () => 42);
    await expect(new JobQueue({ repoOf: (root) => root, loadAverage: () => 95 }).enqueue('vacuum', '/ended', run)).rejects.toBeInstanceOf(JobEndedError);
    expect(run).not.toHaveBeenCalled();
    await new JobQueue({ repoOf: (root) => root, loadAverage: () => 95 }).enqueue('index', '/ended', async () => undefined);
    await expect(new JobQueue({ repoOf: (root) => root, loadAverage: () => 95 }).enqueue('vacuum', '/ended', run)).resolves.toBe(42);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(['cold-build', 'init', 'index'] as const)('does not refuse an ended %s job', async (kind) => {
    endedJobs.add({ ...mark, kind });
    const run = vi.fn(async () => 42);
    await expect(new JobQueue({ repoOf: (root) => root, loadAverage: () => 95 }).enqueue(kind, '/ended', run)).resolves.toBe(42);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(['init', 'index'] as const)('clears only its root after successful %s', async (kind) => {
    endedJobs.add(mark);
    endedJobs.add({ ...mark, root: '/other' });
    await new JobQueue({ repoOf: (root) => root, loadAverage: () => 95 }).enqueue(kind, '/ended', async () => undefined);
    expect(endedJobs.has('/ended', 'sync')).toBe(false);
    expect(endedJobs.has('/other', 'sync')).toBe(true);
  });

  it.each(['init', 'index'] as const)('keeps marks after failed %s', async (kind) => {
    endedJobs.add(mark);
    await expect(new JobQueue({ repoOf: (root) => root, loadAverage: () => 95 }).enqueue(kind, '/ended', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect(endedJobs.has('/ended', 'sync')).toBe(true);
  });
});
