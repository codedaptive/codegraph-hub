import { describe, expect, it, vi } from 'vitest';
import { JobWatchdog } from '../../../src/extensions/host/builder/job-watchdog';
import type { RunningJob } from '../../../src/extensions/host/builder/running-job';

const sync: RunningJob = { id: 1, kind: 'sync', root: '/sync', repo: '/a', lane: 'repo' };
const cold: RunningJob = { id: 2, kind: 'cold-build', root: '/cold', repo: '/a', lane: 'bypass' };

describe('JobWatchdog', () => {
  it('ignores an idle queue and measures time from the first check of each job', () => {
    let now = 100;
    let jobs: RunningJob[] = [];
    const onBreach = vi.fn();
    const watchdog = new JobWatchdog({ runningJobs: () => jobs }, { maxMs: 1000, maxRssMb: 8 }, {
      clock: () => now, readRssBytes: () => 0, onBreach,
    });
    watchdog.check();
    now = 5000;
    jobs = [sync];
    watchdog.check();
    now = 6000;
    watchdog.check();
    expect(onBreach).not.toHaveBeenCalled();
    now = 6001;
    watchdog.check();
    watchdog.check();
    expect(onBreach).toHaveBeenCalledOnce();
    expect(onBreach).toHaveBeenCalledWith({ id: 1, kind: 'sync', root: '/sync', repo: '/a', lane: 'repo' }, { limit: 'time', maxMs: 1000, measuredMs: 1001 });
  });

  it('reports only the older job when the other is not over time', () => {
    let now = 0;
    let jobs = [sync];
    const onBreach = vi.fn();
    const watchdog = new JobWatchdog({ runningJobs: () => jobs }, { maxMs: 1000, maxRssMb: 8 }, {
      clock: () => now, readRssBytes: () => 0, onBreach,
    });
    watchdog.check();
    now = 500;
    jobs = [sync, cold];
    watchdog.check();
    now = 1001;
    watchdog.check();
    expect(onBreach).toHaveBeenCalledOnce();
    expect(onBreach).toHaveBeenCalledWith({ id: 1, kind: 'sync', root: '/sync', repo: '/a', lane: 'repo' }, { limit: 'time', maxMs: 1000, measuredMs: 1001 });
    watchdog.check();
    expect(onBreach).toHaveBeenCalledOnce();
  });

  it('times a later cold job independently and reports it when its own time expires', () => {
    let now = 0;
    let jobs = [sync];
    const onBreach = vi.fn();
    const watchdog = new JobWatchdog({ runningJobs: () => jobs }, { maxMs: 1000, maxRssMb: 8 }, {
      clock: () => now, readRssBytes: () => 0, onBreach,
    });
    watchdog.check();
    now = 500;
    jobs = [sync, cold];
    watchdog.check();
    now = 1001;
    watchdog.check();
    expect(onBreach).toHaveBeenCalledTimes(1);
    now = 1501;
    watchdog.check();
    watchdog.check();
    expect(onBreach).toHaveBeenCalledTimes(2);
    expect(onBreach).toHaveBeenLastCalledWith({ id: 2, kind: 'cold-build', root: '/cold', repo: '/a', lane: 'bypass' }, { limit: 'time', maxMs: 1000, measuredMs: 1001 });
  });

  it('charges process RSS to the whole-repository job even in a bypass slot', () => {
    const onBreach = vi.fn();
    const watchdog = new JobWatchdog({ runningJobs: () => [sync, cold] }, { maxMs: 1000, maxRssMb: 8 }, {
      clock: () => 0, readRssBytes: () => 9437184, onBreach,
    });
    watchdog.check();
    expect(onBreach).toHaveBeenCalledOnce();
    expect(onBreach).toHaveBeenCalledWith({ id: 2, kind: 'cold-build', root: '/cold', repo: '/a', lane: 'bypass' }, { limit: 'rss', maxRssMb: 8, measuredRssMb: 9 });
  });

  it('charges process RSS to a lone sync job', () => {
    let rss = 8388608;
    const onBreach = vi.fn();
    const watchdog = new JobWatchdog({ runningJobs: () => [sync] }, { maxMs: 1000, maxRssMb: 8 }, {
      clock: () => 0, readRssBytes: () => rss, onBreach,
    });
    watchdog.check();
    expect(onBreach).not.toHaveBeenCalled();
    rss = 9437184;
    watchdog.check();
    watchdog.check();
    expect(onBreach).toHaveBeenCalledOnce();
    expect(onBreach).toHaveBeenCalledWith({ id: 1, kind: 'sync', root: '/sync', repo: '/a', lane: 'repo' }, { limit: 'rss', maxRssMb: 8, measuredRssMb: 9 });
  });

  it('reports the first breach in ascending id order, once per job', () => {
    let now = 0;
    const onBreach = vi.fn();
    const watchdog = new JobWatchdog({ runningJobs: () => [sync, cold] }, { maxMs: 1000, maxRssMb: 8 }, {
      clock: () => now, readRssBytes: () => 0, onBreach,
    });
    watchdog.check();
    now = 1001;
    watchdog.check();
    expect(onBreach).toHaveBeenCalledTimes(1);
    expect(onBreach).toHaveBeenNthCalledWith(1, { id: 1, kind: 'sync', root: '/sync', repo: '/a', lane: 'repo' }, { limit: 'time', maxMs: 1000, measuredMs: 1001 });
    watchdog.check();
    watchdog.check();
    expect(onBreach).toHaveBeenCalledTimes(2);
    expect(onBreach).toHaveBeenNthCalledWith(2, { id: 2, kind: 'cold-build', root: '/cold', repo: '/a', lane: 'bypass' }, { limit: 'time', maxMs: 1000, measuredMs: 1001 });
  });

  it('times a new id from its first check after the breached job finishes', () => {
    let now = 0;
    let jobs: RunningJob[] = [sync];
    const onBreach = vi.fn();
    const watchdog = new JobWatchdog({ runningJobs: () => jobs }, { maxMs: 1000, maxRssMb: 8 }, {
      clock: () => now, readRssBytes: () => 0, onBreach,
    });
    watchdog.check();
    now = 1001;
    watchdog.check();
    jobs = [];
    watchdog.check();
    now = 5000;
    jobs = [{ id: 3, kind: 'sync', root: '/new', repo: '/b', lane: 'repo' }];
    watchdog.check();
    now = 6000;
    watchdog.check();
    expect(onBreach).toHaveBeenCalledTimes(1);
    now = 6001;
    watchdog.check();
    expect(onBreach).toHaveBeenCalledTimes(2);
    expect(onBreach).toHaveBeenLastCalledWith({ id: 3, kind: 'sync', root: '/new', repo: '/b', lane: 'repo' }, { limit: 'time', maxMs: 1000, measuredMs: 1001 });
  });

  it('starts an unrefed interval and stops it', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      const onBreach = vi.fn();
      const watchdog = new JobWatchdog({ runningJobs: () => [sync] },
        { maxMs: 1000, maxRssMb: 8 }, { clock: () => 0, readRssBytes: () => 9437184, intervalMs: 5000, onBreach });
      watchdog.start();
      expect(setIntervalSpy).toHaveBeenCalledOnce();
      expect(setIntervalSpy.mock.results[0]?.value.hasRef()).toBe(false);
      vi.advanceTimersByTime(5000);
      expect(onBreach).toHaveBeenCalledOnce();
      watchdog.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      setIntervalSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
