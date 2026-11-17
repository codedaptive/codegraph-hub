/**
 * The index builder's job queue (src/extensions/host/builder/queue.ts): one job at a time, a SYNC class that
 * always goes before the COLD class, FIFO inside each class, no preemption, and the job log's line format.
 *
 * The jobs are hand-held promises, so each case controls exactly when a job ends; nothing here touches disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/directory', () => ({ canonicalProjectRoot: (root: string) => root }));
import { endedJobs } from '../../../src/extensions/host/builder/ended-jobs';
import { JobEndedError } from '../../../src/extensions/host/builder/job-ended-error';
import { JobQueue, formatJobLine, type JobEvent, type JobKind } from '../../../src/extensions/host/builder/queue';

/** A job body the test finishes by hand. */
function held<T = void>(): { run: () => Promise<T>; started: Promise<void>; finish: (value: T) => void; fail: (err: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((r) => { markStarted = r; });
  const done = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { run: () => { markStarted(); return done; }, started, finish: resolve, fail: reject };
}

/** A queue that records its events as `start kind root` / `end kind root`. */
function recordingQueue(): { queue: JobQueue; events: string[]; raw: JobEvent[] } {
  const events: string[] = [];
  const raw: JobEvent[] = [];
  const queue = new JobQueue({
    onEvent: (e) => {
      raw.push(e);
      events.push(`${e.edge} ${e.kind} ${e.root}`);
    },
  });
  return { queue, events, raw };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('JobQueue', () => {
  it('runs a sync queued after a waiting vacuum before that vacuum', async () => {
    const { queue } = recordingQueue();
    const blocker = held();
    const order: string[] = [];
    const first = queue.enqueue('sync', '/blocker', blocker.run);
    await blocker.started;
    const vacuum = queue.enqueue('vacuum', '/project', async () => { order.push('vacuum'); });
    const sync = queue.enqueue('sync', '/project', async () => { order.push('sync'); });
    blocker.finish();
    await Promise.all([first, vacuum, sync]);
    expect(order).toEqual(['sync', 'vacuum']);
  });

  it('a SYNC job queued while a COLD job runs and another COLD waits ends before the second COLD starts', async () => {
    const { queue, events } = recordingQueue();
    const coldX = held();
    const coldY = held();
    const syncZ = held<{ filesChanged: number }>();

    const x = queue.enqueue('cold-build', '/x', coldX.run);
    await coldX.started;
    const y = queue.enqueue('cold-build', '/y', coldY.run);
    const z = queue.enqueue('sync', '/z', syncZ.run);

    // The running job is never preempted: Z waits for X.
    await tick();
    expect(events).toEqual(['start cold-build /x']);

    coldX.finish();
    await x;
    // Z goes ahead of Y although Y was queued first.
    await syncZ.started;
    expect(events).toEqual(['start cold-build /x', 'end cold-build /x', 'start sync /z']);
    syncZ.finish({ filesChanged: 1 });
    await expect(z).resolves.toEqual({ filesChanged: 1 });

    await coldY.started;
    coldY.finish();
    await y;
    expect(events).toEqual([
      'start cold-build /x', 'end cold-build /x',
      'start sync /z', 'end sync /z',
      'start cold-build /y', 'end cold-build /y',
    ]);
  });

  it('keeps first in, first out inside each class, and every SYNC kind is in the SYNC class', async () => {
    const { queue, events } = recordingQueue();
    const first = held();
    const running = queue.enqueue('cold-build', '/cold-1', first.run);
    await first.started;
    const kinds: JobKind[] = ['catch-up', 'watch-sync', 'seed', 'recover', 'sync', 'open'];
    const order: Array<Promise<unknown>> = [];
    order.push(queue.enqueue('cold-build', '/cold-2', async () => undefined));
    kinds.forEach((kind, i) => order.push(queue.enqueue(kind, `/s${i}`, async () => undefined)));
    first.finish();
    await running;
    await Promise.all(order);
    const starts = events.filter((e) => e.startsWith('start ')).map((e) => e.split(' ')[2]);
    expect(starts).toEqual(['/cold-1', '/s0', '/s1', '/s2', '/s3', '/s4', '/s5', '/cold-2']);
  });

  it('runs one job at a time', async () => {
    const { queue } = recordingQueue();
    let live = 0;
    let peak = 0;
    const job = async () => {
      live++;
      peak = Math.max(peak, live);
      await tick();
      live--;
    };
    await Promise.all([
      queue.enqueue('sync', '/a', job),
      queue.enqueue('cold-build', '/b', job),
      queue.enqueue('watch-sync', '/c', job),
      queue.enqueue('catch-up', '/d', job),
    ]);
    expect(peak).toBe(1);
  });

  it('a failed job rejects its caller, logs the failure on one line, and the next job still runs', async () => {
    const { queue, raw } = recordingQueue();
    const bad = queue.enqueue('sync', '/bad', async () => { throw new Error('line one\nline two'); });
    const good = queue.enqueue('sync', '/good', async () => 7);
    await expect(bad).rejects.toThrow('line one');
    await expect(good).resolves.toBe(7);
    const end = raw.find((e) => e.edge === 'end' && e.root === '/bad');
    expect(end).toMatchObject({ ok: false, error: 'line one line two' });
  });

  it('a job that throws before its first await is a rejection, not a crash', async () => {
    const { queue } = recordingQueue();
    const job = queue.enqueue('sync', '/sync-throw', () => { throw new Error('boom'); });
    await expect(job).rejects.toThrow('boom');
    await expect(queue.enqueue('sync', '/after', async () => 1)).resolves.toBe(1);
  });

  it('coalesces a queued job with the same key, but not a running one', async () => {
    const { queue, events } = recordingQueue();
    const blocker = held();
    const first = held<number>();
    queue.enqueue('cold-build', '/cold', blocker.run);
    await blocker.started;

    let runs = 0;
    const body = () => { runs++; return first.run(); };
    const a = queue.enqueue('sync', '/z', body, { coalesceKey: 'sync:/z' });
    const b = queue.enqueue('sync', '/z', body, { coalesceKey: 'sync:/z' });
    expect(b).toBe(a);
    blocker.finish();
    await first.started;
    // The job runs now: a sync asked for after it started may have missed what it read, so it queues its own.
    const second = held<number>();
    const c = queue.enqueue('sync', '/z', () => { runs++; return second.run(); }, { coalesceKey: 'sync:/z' });
    expect(c).not.toBe(a);
    first.finish(1);
    await expect(a).resolves.toBe(1);
    await second.started;
    second.finish(2);
    await expect(c).resolves.toBe(2);
    expect(runs).toBe(2);
    expect(events.filter((e) => e === 'start sync /z')).toHaveLength(2);
  });

  it('close() drops the queued jobs, lets the running one finish, and refuses new ones', async () => {
    const { queue, events } = recordingQueue();
    const running = held();
    const r = queue.enqueue('cold-build', '/running', running.run);
    await running.started;
    const queued = queue.enqueue('sync', '/queued', async () => undefined);
    const queuedOutcome = queued.then(() => 'ran', (e: Error) => e.message);

    const closed = queue.close();
    await expect(queuedOutcome).resolves.toMatch(/stopping/);
    await expect(queue.enqueue('sync', '/late', async () => undefined)).rejects.toThrow(/stopping/);
    running.finish();
    await r;
    await closed;
    expect(events).toEqual(['start cold-build /running', 'end cold-build /running']);
  });

  it('whenIdle() resolves once nothing runs or waits', async () => {
    const { queue } = recordingQueue();
    await queue.whenIdle();
    const job = held();
    const done = queue.enqueue('sync', '/a', job.run);
    let idle = false;
    void queue.whenIdle().then(() => { idle = true; });
    await job.started;
    await tick();
    expect(idle).toBe(false);
    job.finish();
    await done;
    await tick();
    expect(idle).toBe(true);
  });

  it('whenRootIdle() counts a job for its own root and for each of its alsoRoots, and for no other root', async () => {
    const { queue } = recordingQueue();
    const job = held();
    const done = queue.enqueue('seed', '/worktree', job.run, { alsoRoots: ['/source'] });
    await job.started;
    let source = false;
    let other = false;
    void queue.whenRootIdle('/source').then(() => { source = true; });
    void queue.whenRootIdle('/other').then(() => { other = true; });
    await tick();
    expect(other, 'a root the job does not name is idle at once').toBe(true);
    expect(source, 'the source the seed reads is not idle while the seed runs').toBe(false);
    job.finish();
    await done;
    await tick();
    expect(source, 'the source is idle once the seed ended').toBe(true);
  });
});

describe('JobQueue job limits', () => {
  const mark = { root: '/ended', kind: 'sync' as const, limit: 'time' as const, at: '2026-11-16T10:00:00.000Z' };
  beforeEach(() => endedJobs.replaceAll([]));
  afterEach(() => endedJobs.replaceAll([]));

  it('reports successive running job ids and null while idle', async () => {
    const queue = new JobQueue();
    expect(queue.runningJob()).toBeNull();
    const first = held();
    const a = queue.enqueue('sync', '/first', first.run);
    await first.started;
    expect(queue.runningJob()).toEqual({ id: 1, kind: 'sync', root: '/first' });
    const second = held();
    const b = queue.enqueue('open', '/second', second.run);
    first.finish();
    await a;
    await second.started;
    expect(queue.runningJob()).toEqual({ id: 2, kind: 'open', root: '/second' });
    second.finish();
    await b;
    expect(queue.runningJob()).toBeNull();
  });

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

  it.each(['cold-build', 'init', 'index'] as const)('does not refuse an ended %s job', async (kind) => {
    endedJobs.add({ ...mark, kind });
    const run = vi.fn(async () => 42);
    await expect(new JobQueue().enqueue(kind, '/ended', run)).resolves.toBe(42);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(['init', 'index'] as const)('clears only its root after successful %s', async (kind) => {
    endedJobs.add(mark);
    endedJobs.add({ ...mark, root: '/other' });
    await new JobQueue().enqueue(kind, '/ended', async () => undefined);
    expect(endedJobs.has('/ended', 'sync')).toBe(false);
    expect(endedJobs.has('/other', 'sync')).toBe(true);
  });

  it.each(['init', 'index'] as const)('keeps marks after failed %s', async (kind) => {
    endedJobs.add(mark);
    await expect(new JobQueue().enqueue(kind, '/ended', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect(endedJobs.has('/ended', 'sync')).toBe(true);
  });
});

describe('job log lines (builder.log)', () => {
  const at = new Date('2026-10-31T12:00:00.000Z');

  it('writes `<ISO8601> job start <kind> <root>` and `<ISO8601> job end <kind> <root> ok|failed[: msg]`', () => {
    expect(formatJobLine({ edge: 'start', kind: 'cold-build', root: '/w' }, at)).toBe('2026-10-31T12:00:00.000Z job start cold-build /w');
    expect(formatJobLine({ edge: 'end', kind: 'sync', root: '/w', ok: true }, at)).toBe('2026-10-31T12:00:00.000Z job end sync /w ok');
    expect(formatJobLine({ edge: 'end', kind: 'seed', root: '/w', ok: false, error: 'copy failed' }, at))
      .toBe('2026-10-31T12:00:00.000Z job end seed /w failed: copy failed');
  });
});
