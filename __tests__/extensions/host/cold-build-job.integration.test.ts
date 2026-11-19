import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const admitColdBuild = vi.hoisted(() => vi.fn());
vi.mock('../../../src/directory', () => ({ canonicalProjectRoot: (root: string) => root }));
vi.mock('../../../src/extensions/host/worktree-lifecycle/seed', () => ({ admitColdBuild }));
vi.mock('../../../src/extensions/host/worktree-lifecycle/cold-build', () => ({
  COLD_BUILD_EXIT_BUILT: 0, COLD_BUILD_EXIT_FAILED: 1, COLD_BUILD_EXIT_BUSY: 3, COLD_BUILD_EXIT_LOCKED: 4,
}));

import { coldBuildJob } from '../../../src/extensions/host/builder/cold-build-job';
import { endedJobs } from '../../../src/extensions/host/builder/ended-jobs';

const root = '/repo';
const approval = { realRoot: root };

function deps(codes: number[], fenced = false) {
  const runJob = vi.fn(async (_id: number, _spec: unknown) => codes.shift());
  return { runJob, fences: { isFenced: vi.fn(() => fenced) }, attempts: 2, delayMs: 0, onFailed: vi.fn() };
}

beforeEach(() => {
  endedJobs.replaceAll([]);
  admitColdBuild.mockReset();
  admitColdBuild.mockReturnValue({ ok: true, approval });
});
afterEach(() => endedJobs.replaceAll([]));

describe('coldBuildJob', () => {
  it('runs one attempt in a child for the root and resolves when it built', async () => {
    const d = deps([0]);
    await coldBuildJob(5, root, approval, d);
    expect(d.runJob).toHaveBeenCalledOnce();
    expect(d.runJob.mock.calls[0]?.[0]).toBe(5);
    expect(d.runJob.mock.calls[0]?.[1]).toMatchObject({ kind: 'cold-build', root, export: 'coldBuildBody', args: { root } });
  });

  it('refuses a root ended over a limit without starting a child', async () => {
    endedJobs.add({ root, kind: 'cold-build', limit: 'rss', at: '2026-11-16T10:00:00.000Z' });
    const d = deps([0]);
    await expect(coldBuildJob(5, root, approval, d)).rejects.toMatchObject({ name: 'JobEndedError' });
    expect(d.runJob).not.toHaveBeenCalled();
  });

  it('tries again after a locked attempt, with the same job id', async () => {
    const d = deps([4, 0]);
    await coldBuildJob(5, root, approval, d);
    expect(d.runJob.mock.calls.map((call) => call[0])).toEqual([5, 5]);
    expect(admitColdBuild).toHaveBeenCalledTimes(2);
  });

  it('rejects once every attempt was locked', async () => {
    const d = deps([4, 4]);
    await expect(coldBuildJob(5, root, approval, d)).rejects.toThrow('the database stayed locked after 2 attempts');
    expect(d.onFailed).not.toHaveBeenCalled();
  });

  it('records a failed build and does not try again', async () => {
    const d = deps([1, 0]);
    await expect(coldBuildJob(5, root, approval, d)).rejects.toThrow('the cold build failed');
    expect(d.onFailed).toHaveBeenCalledOnce();
    expect(d.runJob).toHaveBeenCalledOnce();
  });

  it('rejects when another process holds rebuild.pid, without recording a failure', async () => {
    const d = deps([3]);
    await expect(coldBuildJob(5, root, approval, d)).rejects.toThrow('another process holds rebuild.pid');
    expect(d.onFailed).not.toHaveBeenCalled();
  });

  it('starts no child when admission refuses the root', async () => {
    admitColdBuild.mockReturnValue({ ok: false, why: 'folder', reason: 'gone' });
    const d = deps([0]);
    await expect(coldBuildJob(5, root, approval, d)).rejects.toThrow('the cold build was not started: gone');
    expect(d.runJob).not.toHaveBeenCalled();
  });

  it('starts no child when a rebuild fence holds the root', async () => {
    const d = deps([0], true);
    await expect(coldBuildJob(5, root, approval, d)).rejects.toThrow('an index rebuild holds the root');
    expect(d.runJob).not.toHaveBeenCalled();
  });
});
