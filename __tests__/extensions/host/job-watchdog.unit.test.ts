import { describe, expect, it, vi } from 'vitest';
import { JobWatchdog } from '../../../src/extensions/host/builder/job-watchdog';
import type { JobQueue } from '../../../src/extensions/host/builder/queue';

describe('JobWatchdog', () => {
  it('ignores an idle queue and measures time from the first check of each job', () => {
    let now = 100;
    let job: ReturnType<JobQueue['runningJob']> = null;
    const onBreach = vi.fn();
    const watchdog = new JobWatchdog({ runningJob: () => job }, { maxMs: 1000, maxRssMb: 8 }, {
      clock: () => now, readRssBytes: () => 0, onBreach,
    });
    watchdog.check();
    now = 5000;
    job = { id: 1, kind: 'sync', root: '/a' };
    watchdog.check();
    now = 6000;
    watchdog.check();
    expect(onBreach).not.toHaveBeenCalled();
    now = 6001;
    watchdog.check();
    watchdog.check();
    expect(onBreach).toHaveBeenCalledOnce();
    expect(onBreach).toHaveBeenCalledWith({ id: 1, kind: 'sync', root: '/a' }, { limit: 'time', maxMs: 1000, measuredMs: 1001 });
    job = { id: 2, kind: 'sync', root: '/a' };
    watchdog.check();
    expect(onBreach).toHaveBeenCalledOnce();
    now = 7002;
    watchdog.check();
    expect(onBreach).toHaveBeenCalledTimes(2);
    expect(onBreach).toHaveBeenLastCalledWith({ id: 2, kind: 'sync', root: '/a' }, { limit: 'time', maxMs: 1000, measuredMs: 1001 });
  });

  it('checks injected resident memory and reports a breach only once per job', () => {
    const onBreach = vi.fn();
    let rss = 8 * 1024 * 1024;
    const watchdog = new JobWatchdog({ runningJob: () => ({ id: 1, kind: 'open', root: '/r' }) },
      { maxMs: 1000, maxRssMb: 8 }, { clock: () => 0, readRssBytes: () => rss, onBreach });
    watchdog.check();
    expect(onBreach).not.toHaveBeenCalled();
    rss = 9 * 1024 * 1024;
    watchdog.check();
    watchdog.check();
    expect(onBreach).toHaveBeenCalledOnce();
    expect(onBreach).toHaveBeenCalledWith({ id: 1, kind: 'open', root: '/r' }, { limit: 'rss', maxRssMb: 8, measuredRssMb: 9 });
  });

  it('starts an unrefed interval and stops it', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      const onBreach = vi.fn();
      const watchdog = new JobWatchdog({ runningJob: () => ({ id: 1, kind: 'sync', root: '/r' }) },
        { maxMs: 1000, maxRssMb: 8 }, { clock: () => 0, readRssBytes: () => 9 * 1024 * 1024, intervalMs: 5000, onBreach });
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
