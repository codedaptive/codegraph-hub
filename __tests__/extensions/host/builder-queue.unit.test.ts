/**
 * The index builder's job queue: two lanes, root exclusion, FIFO cold jobs, and the job log's line format.
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
  it('starts a sync of another root synchronously alongside a cold build', async () => {
    const { queue, events } = recordingQueue();
    const cold = held();
    const sync = held();
    const a = queue.enqueue('cold-build', '/a', cold.run);
    const b = queue.enqueue('sync', '/b', sync.run);
    expect(events).toEqual(['start cold-build /a', 'start sync /b']);
    cold.finish();
    sync.finish();
    await Promise.all([a, b]);
  });

  it('starts cold jobs in FIFO order and never overlaps them', async () => {
    const { queue, events } = recordingQueue();
    const first = held();
    const second = held();
    const a = queue.enqueue('index', '/a', first.run);
    const b = queue.enqueue('init', '/b', second.run);
    const c = queue.enqueue('cold-build', '/c', async () => undefined);
    expect(events).toEqual(['start index /a']);
    first.finish();
    await a;
    expect(events).toEqual(['start index /a', 'end index /a', 'start init /b']);
    second.finish();
    await Promise.all([b, c]);
    expect(events).toEqual(['start index /a', 'end index /a', 'start init /b', 'end init /b', 'start cold-build /c', 'end cold-build /c']);
  });

  it('blocks a sync of the same root as a running cold job', async () => {
    const { queue, events } = recordingQueue();
    const cold = held();
    const a = queue.enqueue('cold-build', '/a', cold.run);
    const b = queue.enqueue('sync', '/a', async () => undefined);
    expect(events).toEqual(['start cold-build /a']);
    cold.finish();
    await Promise.all([a, b]);
    expect(events).toEqual(['start cold-build /a', 'end cold-build /a', 'start sync /a', 'end sync /a']);
  });

  it('gives a waiting sync of the cold head root priority', async () => {
    const { queue, events } = recordingQueue();
    const cold = held();
    const sync = held();
    const blocker = held();
    const first = queue.enqueue('index', '/a', cold.run);
    const occupied = queue.enqueue('sync', '/c', blocker.run);
    const next = queue.enqueue('index', '/b', async () => undefined);
    const waiting = queue.enqueue('sync', '/b', sync.run);
    expect(events).toEqual(['start index /a', 'start sync /c']);
    cold.finish();
    await first;
    expect(events).not.toContain('start index /b');
    blocker.finish();
    await occupied;
    expect(events).toContain('start sync /b');
    expect(events).not.toContain('start index /b');
    sync.finish();
    await Promise.all([waiting, next]);
    expect(events.indexOf('end sync /b')).toBeLessThan(events.indexOf('start index /b'));
  });

  it('skips busy sync roots while preserving same-root order', async () => {
    const { queue, events } = recordingQueue();
    const cold = held();
    const other = held();
    const first = queue.enqueue('index', '/a', cold.run);
    const a1 = queue.enqueue('sync', '/a', async () => undefined);
    const a2 = queue.enqueue('watch-sync', '/a', async () => undefined);
    const b = queue.enqueue('sync', '/b', other.run);
    expect(events).toEqual(['start index /a', 'start sync /b']);
    cold.finish();
    await first;
    expect(events).not.toContain('start sync /a');
    other.finish();
    await Promise.all([a1, a2, b]);
    expect(events.indexOf('start sync /a')).toBeLessThan(events.indexOf('start watch-sync /a'));
  });

  it('does not skip a blocked cold head for a later cold job', async () => {
    const { queue, events } = recordingQueue();
    const sync = held();
    const first = queue.enqueue('sync', '/a', sync.run);
    const head = queue.enqueue('index', '/a', async () => undefined);
    const later = queue.enqueue('index', '/b', async () => undefined);
    expect(events).toEqual(['start sync /a']);
    sync.finish();
    await Promise.all([first, head, later]);
    expect(events.indexOf('start index /a')).toBeLessThan(events.indexOf('start index /b'));
  });

  it('blocks a cold job whose additional root is running in the sync lane', async () => {
    const { queue, events } = recordingQueue();
    const sync = held();
    const a = queue.enqueue('seed', '/work', sync.run, { alsoRoots: ['/source'] });
    const b = queue.enqueue('index', '/other', async () => undefined, { alsoRoots: ['/source'] });
    expect(events).toEqual(['start seed /work']);
    sync.finish();
    await Promise.all([a, b]);
    expect(events.indexOf('end seed /work')).toBeLessThan(events.indexOf('start index /other'));
  });

  it('whenIdle and close wait for both running lanes', async () => {
    const queue = new JobQueue();
    const cold = held();
    const sync = held();
    const a = queue.enqueue('index', '/a', cold.run);
    const b = queue.enqueue('sync', '/b', sync.run);
    const waiting = queue.enqueue('index', '/c', async () => undefined);
    const rejected = expect(waiting).rejects.toThrow(/stopping/);
    let idle = false;
    let closed = false;
    void queue.whenIdle().then(() => { idle = true; });
    const closing = queue.close().then(() => { closed = true; });
    await rejected;
    cold.finish();
    await a;
    await tick();
    expect(idle).toBe(false);
    expect(closed).toBe(false);
    sync.finish();
    await b;
    await closing;
    await tick();
    expect(idle).toBe(true);
    expect(closed).toBe(true);
  });

  it('respects root and lane limits across a generated mix', async () => {
    const { queue } = recordingQueue();
    const live = new Map<string, number>();
    let coldLive = 0;
    let total = 0;
    let peak = 0;
    const jobs: Array<Promise<void>> = [];
    for (let i = 0; i < 36; i++) {
      const root = `/r${i % 3}`;
      const kind: JobKind = i % 2 === 0 ? 'index' : 'sync';
      jobs.push(queue.enqueue(kind, root, async () => {
        live.set(root, (live.get(root) ?? 0) + 1);
        if (kind === 'index') coldLive++;
        total++;
        peak = Math.max(peak, total);
        expect(live.get(root)).toBe(1);
        expect(coldLive).toBeLessThanOrEqual(1);
        expect(total).toBeLessThanOrEqual(2);
        await Promise.resolve();
        live.set(root, (live.get(root) ?? 0) - 1);
        if (kind === 'index') coldLive--;
        total--;
      }));
    }
    await Promise.all(jobs);
    expect(peak).toBe(2);
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
    queue.enqueue('cold-build', '/z', blocker.run);
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
    const queued = queue.enqueue('sync', '/running', async () => undefined);
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

  it('reports both running jobs in ascending id order with lanes and one counter', async () => {
    const queue = new JobQueue();
    expect(queue.runningJobs()).toEqual([]);
    const first = held();
    const second = held();
    const a = queue.enqueue('index', '/first', first.run);
    const b = queue.enqueue('open', '/second', second.run);
    expect(queue.runningJobs()).toEqual([
      { id: 1, kind: 'index', root: '/first', lane: 'cold' },
      { id: 2, kind: 'open', root: '/second', lane: 'sync' },
    ]);
    first.finish();
    await a;
    const third = held();
    const c = queue.enqueue('cold-build', '/third', third.run);
    expect(queue.runningJobs()).toEqual([
      { id: 2, kind: 'open', root: '/second', lane: 'sync' },
      { id: 3, kind: 'cold-build', root: '/third', lane: 'cold' },
    ]);
    second.finish();
    third.finish();
    await Promise.all([b, c]);
    expect(queue.runningJobs()).toEqual([]);
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
