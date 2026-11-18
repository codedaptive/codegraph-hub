import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobEventListener } from '../../../src/extensions/host/builder/job-event-listener';
import { vacuumAfterJob } from '../../../src/extensions/host/builder/vacuum-after-job';

vi.mock('../../../src/extensions/host/builder/vacuum-after-job', () => ({ vacuumAfterJob: vi.fn() }));

const start = { edge: 'start', kind: 'sync', root: '/project' } as const;
const success = { edge: 'end', kind: 'sync', root: '/project', ok: true } as const;
const failed = { edge: 'end', kind: 'sync', root: '/project', ok: false, error: 'write failed' } as const;

// formatJobLine stamps each line with the current time; a fixed fake clock keeps the real one out of this test.
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-02T03:04:05.678Z'));
});
afterEach(() => vi.useRealTimers());

describe('jobEventListener', () => {
  it('logs exactly the start line without reading the queue', () => {
    const jobLog = vi.fn();
    const queue = vi.fn(() => ({ enqueue: vi.fn() }));
    const listen = jobEventListener({ jobLog, queue, rebuildHeld: () => false });
    listen(start);
    expect(jobLog).toHaveBeenCalledTimes(1);
    expect(jobLog.mock.calls[0][0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z job start sync \/project$/);
    expect(queue).not.toHaveBeenCalled();
  });

  it('logs exactly the failed end line without reading the queue', () => {
    const jobLog = vi.fn();
    const queue = vi.fn(() => ({ enqueue: vi.fn() }));
    jobEventListener({ jobLog, queue, rebuildHeld: () => false })(failed);
    expect(jobLog).toHaveBeenCalledTimes(1);
    expect(jobLog.mock.calls[0][0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z job end sync \/project failed: write failed$/);
    expect(queue).not.toHaveBeenCalled();
  });

  it('reads the current queue at the event, not at construction', () => {
    const first = { enqueue: vi.fn() };
    const second = { enqueue: vi.fn() };
    let current = first;
    const queue = vi.fn(() => current);
    const jobLog = vi.fn();
    const listen = jobEventListener({ jobLog, queue, rebuildHeld: () => false });
    expect(queue).not.toHaveBeenCalled();
    current = second;
    listen(success);
    expect(jobLog).toHaveBeenCalledTimes(1);
    expect(jobLog.mock.calls[0][0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z job end sync \/project ok$/);
    expect(vacuumAfterJob).toHaveBeenCalledOnce();
    const deps = vi.mocked(vacuumAfterJob).mock.calls[0][1];
    expect(deps.queue.enqueue).toBe(second.enqueue);
    expect(vi.mocked(vacuumAfterJob).mock.calls[0][0]).toEqual(success);
    expect(jobLog.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(vacuumAfterJob).mock.invocationCallOrder[0]);
  });

  it('does not throw when the vacuum work fails', () => {
    vi.mocked(vacuumAfterJob).mockImplementationOnce(() => { throw new Error('vacuum failed'); });
    const jobLog = vi.fn();
    const listen = jobEventListener({ jobLog, queue: () => ({ enqueue: vi.fn() }), rebuildHeld: () => false });
    expect(() => listen(success)).not.toThrow();
    expect(jobLog).toHaveBeenCalledTimes(1);
  });
});
