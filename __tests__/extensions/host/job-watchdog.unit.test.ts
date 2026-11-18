import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.spyOn(process.memoryUsage, 'rss').mockReturnValue(0));
afterEach(() => vi.restoreAllMocks());
import { JobWatchdog } from '../../../src/extensions/host/builder/job-watchdog';
import type { RunningJob } from '../../../src/extensions/host/builder/running-job';

const sync: RunningJob = { id: 1, kind: 'sync', root: '/sync', repo: '/a', lane: 'repo' };
const cold: RunningJob = { id: 2, kind: 'cold-build', root: '/cold', repo: '/a', lane: 'bypass' };

describe('JobWatchdog', async () => {
  it('does not judge a parent prelude but counts its time when the child starts', async () => {
    let now = 0;
    let pid: number | null = null;
    const onBreach = vi.fn();
    const watchdog = new JobWatchdog({ runningJobs: () => [sync] }, { maxMs: 1000, maxRssMb: 8 }, {
      clock: () => now, childPid: () => pid, readChildRssBytes: async () => 0, onBreach,
    });
    await watchdog.check();
    now = 1001;
    await watchdog.check();
    expect(onBreach).not.toHaveBeenCalled();
    pid = 101;
    await watchdog.check();
    expect(onBreach).toHaveBeenCalledExactlyOnceWith(sync, { limit: 'time', maxMs: 1000, measuredMs: 1001 }, 101);
  });
  it('ignores an idle queue and measures time from the first check of each job', async () => {
    let now = 100;
    let jobs: RunningJob[] = [];
    const onBreach = vi.fn();
    const watchdog = new JobWatchdog({ runningJobs: () => jobs }, { maxMs: 1000, maxRssMb: 8 }, {
      clock: () => now, childPid: (id: number) => 100 + id, readChildRssBytes: async () => 0, onBreach,
    });
    await watchdog.check();
    now = 5000;
    jobs = [sync];
    await watchdog.check();
    now = 6000;
    await watchdog.check();
    expect(onBreach).not.toHaveBeenCalled();
    now = 6001;
    await watchdog.check();
    await watchdog.check();
    expect(onBreach).toHaveBeenCalledOnce();
    expect(onBreach).toHaveBeenCalledWith({ id: 1, kind: 'sync', root: '/sync', repo: '/a', lane: 'repo' }, { limit: 'time', maxMs: 1000, measuredMs: 1001 }, 101);
  });

  it('reports only the older job when the other is not over time', async () => {
    let now = 0;
    let jobs = [sync];
    const onBreach = vi.fn();
    const watchdog = new JobWatchdog({ runningJobs: () => jobs }, { maxMs: 1000, maxRssMb: 8 }, {
      clock: () => now, childPid: (id: number) => 100 + id, readChildRssBytes: async () => 0, onBreach,
    });
    await watchdog.check();
    now = 500;
    jobs = [sync, cold];
    await watchdog.check();
    now = 1001;
    await watchdog.check();
    expect(onBreach).toHaveBeenCalledOnce();
    expect(onBreach).toHaveBeenCalledWith({ id: 1, kind: 'sync', root: '/sync', repo: '/a', lane: 'repo' }, { limit: 'time', maxMs: 1000, measuredMs: 1001 }, 101);
    await watchdog.check();
    expect(onBreach).toHaveBeenCalledOnce();
  });

  it('times a later cold job independently and reports it when its own time expires', async () => {
    let now = 0;
    let jobs = [sync];
    const onBreach = vi.fn();
    const watchdog = new JobWatchdog({ runningJobs: () => jobs }, { maxMs: 1000, maxRssMb: 8 }, {
      clock: () => now, childPid: (id: number) => 100 + id, readChildRssBytes: async () => 0, onBreach,
    });
    await watchdog.check();
    now = 500;
    jobs = [sync, cold];
    await watchdog.check();
    now = 1001;
    await watchdog.check();
    expect(onBreach).toHaveBeenCalledTimes(1);
    now = 1501;
    await watchdog.check();
    await watchdog.check();
    expect(onBreach).toHaveBeenCalledTimes(2);
    expect(onBreach).toHaveBeenLastCalledWith({ id: 2, kind: 'cold-build', root: '/cold', repo: '/a', lane: 'bypass' }, { limit: 'time', maxMs: 1000, measuredMs: 1001 }, 102);
  });

  it('reports the first breach in ascending id order, once per job', async () => {
    let now = 0;
    const onBreach = vi.fn();
    const watchdog = new JobWatchdog({ runningJobs: () => [sync, cold] }, { maxMs: 1000, maxRssMb: 8 }, {
      clock: () => now, childPid: (id: number) => 100 + id, readChildRssBytes: async () => 0, onBreach,
    });
    await watchdog.check();
    now = 1001;
    await watchdog.check();
    expect(onBreach).toHaveBeenCalledTimes(1);
    expect(onBreach).toHaveBeenNthCalledWith(1, { id: 1, kind: 'sync', root: '/sync', repo: '/a', lane: 'repo' }, { limit: 'time', maxMs: 1000, measuredMs: 1001 }, 101);
    await watchdog.check();
    await watchdog.check();
    expect(onBreach).toHaveBeenCalledTimes(2);
    expect(onBreach).toHaveBeenNthCalledWith(2, { id: 2, kind: 'cold-build', root: '/cold', repo: '/a', lane: 'bypass' }, { limit: 'time', maxMs: 1000, measuredMs: 1001 }, 102);
  });

  it('times a new id from its first check after the breached job finishes', async () => {
    let now = 0;
    let jobs: RunningJob[] = [sync];
    const onBreach = vi.fn();
    const watchdog = new JobWatchdog({ runningJobs: () => jobs }, { maxMs: 1000, maxRssMb: 8 }, {
      clock: () => now, childPid: (id: number) => 100 + id, readChildRssBytes: async () => 0, onBreach,
    });
    await watchdog.check();
    now = 1001;
    await watchdog.check();
    jobs = [];
    await watchdog.check();
    now = 5000;
    jobs = [{ id: 3, kind: 'sync', root: '/new', repo: '/b', lane: 'repo' }];
    await watchdog.check();
    now = 6000;
    await watchdog.check();
    expect(onBreach).toHaveBeenCalledTimes(1);
    now = 6001;
    await watchdog.check();
    expect(onBreach).toHaveBeenCalledTimes(2);
    expect(onBreach).toHaveBeenLastCalledWith({ id: 3, kind: 'sync', root: '/new', repo: '/b', lane: 'repo' }, { limit: 'time', maxMs: 1000, measuredMs: 1001 }, 103);
  });

  it('starts an unrefed interval and stops it', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      const onBreach = vi.fn();
      const watchdog = new JobWatchdog({ runningJobs: () => [sync] },
        { maxMs: 1000, maxRssMb: 8 }, { clock: () => 0, childPid: () => 101, readChildRssBytes: async () => 9437184, intervalMs: 5000, onBreach });
      watchdog.start();
      expect(setIntervalSpy).toHaveBeenCalledOnce();
      expect(setIntervalSpy.mock.results[0]?.value.hasRef()).toBe(false);
      await vi.advanceTimersByTimeAsync(5000);
      expect(onBreach).toHaveBeenCalledOnce();
      watchdog.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      setIntervalSpy.mockRestore();
      vi.useRealTimers();
    }
  });
  it('charges each child its own RSS and reports the second pid', async () => {
    const onBreach = vi.fn();
    const opts = { clock: () => 0, onBreach,
      childPid: (id: number) => id === 1 ? 101 : 102,
      readChildRssBytes: async (pid: number) => pid === 101 ? 1048576 : 9437184 };
    const watchdog = new JobWatchdog({ runningJobs: () => [sync, cold] }, { maxMs: 1000, maxRssMb: 8 }, opts);
    await watchdog.check();
    expect(onBreach).toHaveBeenCalledOnce();
    expect(onBreach).toHaveBeenCalledWith(cold, { limit: 'rss', maxRssMb: 8, measuredRssMb: 9 }, 102);
  });

  it('charges child RSS to the child beside a no-child cold build', async () => {
    const onBreach = vi.fn();
    const opts = { clock: () => 0, onBreach,
      childPid: (id: number) => id === 1 ? 101 : null,
      readChildRssBytes: async () => 9437184 };
    const watchdog = new JobWatchdog({ runningJobs: () => [sync, cold] }, { maxMs: 1000, maxRssMb: 8 }, opts);
    await watchdog.check();
    expect(onBreach).toHaveBeenCalledWith(sync, { limit: 'rss', maxRssMb: 8, measuredRssMb: 9 }, 101);
  });

  it('does not charge builder RSS to a child with an unavailable RSS sample', async () => {
    const onBreach = vi.fn();
    const opts = { clock: () => 0, onBreach,
      childPid: () => 101, readChildRssBytes: async () => null };
    const watchdog = new JobWatchdog({ runningJobs: () => [sync] }, { maxMs: 1000, maxRssMb: 8 }, opts);
    await watchdog.check();
    expect(onBreach).not.toHaveBeenCalled();
  });

  it('skips a second check while a child RSS sample is pending', async () => {
    let finish: (rss: number | null) => void = () => undefined;
    const sample = new Promise<number | null>((resolve) => { finish = resolve; });
    const readChildRssBytes = vi.fn(() => sample);
    const opts = { clock: () => 0, onBreach: vi.fn(), childPid: () => 101, readChildRssBytes };
    const watchdog = new JobWatchdog({ runningJobs: () => [sync] }, { maxMs: 1000, maxRssMb: 8 }, opts);
    const first = watchdog.check();
    await watchdog.check();
    expect(readChildRssBytes).toHaveBeenCalledOnce();
    finish(0);
    await first;
  });

});
