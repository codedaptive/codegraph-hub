/**
 * The index builder's per-repository queue, bypass slots, root exclusion, and job log.
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
function recordingQueue(repoOf: (root: string) => string = (root) => root, loadAverage: () => number = () => 95): { queue: JobQueue; events: string[]; raw: JobEvent[] } {
  const events: string[] = [];
  const raw: JobEvent[] = [];
  const queue = new JobQueue({
    repoOf, loadAverage,
    onEvent: (e) => {
      raw.push(e);
      events.push(`${e.edge} ${e.kind} ${e.root}`);
    },
  });
  return { queue, events, raw };
}

describe('JobQueue', () => {
  it('captures the repository key once at enqueue rather than looking it up at each pick', async () => {
    let key = 'original';
    const repoOf = vi.fn(() => key);
    const { queue } = recordingQueue(repoOf, () => 95);
    const first = held(); const next = held();
    const a = queue.enqueue('sync', '/worktree-a', first.run);
    const b = queue.enqueue('sync', '/worktree-b', next.run);
    expect(repoOf).toHaveBeenCalledTimes(2);
    expect(queue.runningJobs()).toEqual([{ id: 1, kind: 'sync', root: '/worktree-a', repo: 'original', lane: 'repo' }]);
    key = 'changed';
    first.finish();
    await a;
    expect(repoOf).toHaveBeenCalledTimes(2);
    expect(queue.runningJobs()).toEqual([{ id: 2, kind: 'sync', root: '/worktree-b', repo: 'original', lane: 'repo' }]);
    next.finish();
    await b;
  });

  it('keeps repo and root exclusion when a job enqueues synchronously before its first await', async () => {
    const { queue } = recordingQueue(() => 'shared', () => 94.9);
    const parent = held(); const child = held();
    const nested: Array<Promise<void>> = [];
    const first = queue.enqueue('index', '/a', () => {
      nested.push(queue.enqueue('sync', '/b', child.run));
      nested.push(queue.enqueue('sync', '/a', async () => undefined));
      return parent.run();
    });
    expect(queue.runningJobs()).toEqual([
      { id: 1, kind: 'index', root: '/a', repo: 'shared', lane: 'repo' },
      { id: 2, kind: 'sync', root: '/b', repo: 'shared', lane: 'bypass' },
    ]);
    expect(queue.waiting()).toBe(1);
    parent.finish(); child.finish();
    await Promise.all([first, ...nested]);
  });

  it('whenIdle waits for several repository lanes and a bypass slot', async () => {
    const { queue } = recordingQueue((root) => root.slice(0, 2), () => 0);
    const a = held(); const b = held(); const c = held();
    const first = queue.enqueue('sync', '/a1', a.run);
    const second = queue.enqueue('sync', '/a2', b.run);
    const third = queue.enqueue('sync', '/b1', c.run);
    expect(queue.runningJobs().map((job) => job.lane)).toEqual(['repo', 'bypass', 'repo']);
    let idle = false;
    const done = queue.whenIdle().then(() => { idle = true; });
    a.finish(); await first;
    expect(idle).toBe(false);
    b.finish(); await second;
    expect(idle).toBe(false);
    c.finish(); await third;
    await done;
    expect(idle).toBe(true);
  });

  it('close rejects waiting jobs across repositories and waits for repo and bypass jobs', async () => {
    const { queue } = recordingQueue((root) => root.slice(0, 2), () => 0);
    const a = held(); const b = held(); const c = held();
    const running = [queue.enqueue('sync', '/a1', a.run), queue.enqueue('sync', '/a2', b.run), queue.enqueue('sync', '/b1', c.run)];
    const waitingA = queue.enqueue('index', '/a1', async () => undefined);
    const waitingB = queue.enqueue('index', '/b1', async () => undefined);
    const rejectedA = expect(waitingA).rejects.toThrow(/stopping/);
    const rejectedB = expect(waitingB).rejects.toThrow(/stopping/);
    expect(queue.runningJobs().map((job) => job.lane)).toEqual(['repo', 'bypass', 'repo']);
    expect(queue.waiting()).toBe(2);
    let closed = false;
    const closing = queue.close().then(() => { closed = true; });
    await Promise.all([rejectedA, rejectedB]);
    expect(closed).toBe(false);
    a.finish(); b.finish();
    await Promise.all(running.slice(0, 2));
    expect(closed).toBe(false);
    c.finish();
    await Promise.all([...running, closing]);
    expect(closed).toBe(true);
  });

  it('preserves slot, load and root invariants for a generated mix at every start', async () => {
    let seed = 0x89123456;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 8; };
    let load = 95;
    const { queue } = recordingQueue((root) => root.split('/')[1], () => load);
    const roots = Array.from({ length: 12 }, (_, i) => `/r${Math.floor(i / 4)}/w${i % 4}`);
    const kinds: JobKind[] = ['sync', 'catch-up', 'seed', 'open', 'cold-build', 'init', 'index', 'vacuum'];
    const active = new Map<string, ReadonlySet<string>>();
    const started = new Map<string, number>();
    const failures: string[] = [];
    const loadsAtStart = new Set<number>();
    const gates: Array<{ finish: () => void }> = [];
    const jobs: Array<Promise<void>> = [];
    for (let i = 0; i < 48; i++) {
      const root = i === 0 ? roots[0] : i === 1 ? roots[4] : roots[random() % roots.length];
      const extra = i < 2 || random() % 2 === 0 ? [] : [roots[random() % roots.length]];
      const kind = kinds[random() % kinds.length];
      const gate = held();
      gates.push(gate);
      load = i % 2 === 0 ? 95 : 94.9;
      jobs.push(queue.enqueue(kind, root, async () => {
        started.set(root, i);
        try {
          expect(active.has(root)).toBe(false);
          active.set(root, new Set([root, ...extra]));
          const running = queue.runningJobs();
          const self = running.find((job) => job.root === root);
          expect(self).toMatchObject({ root, kind, repo: root.split('/')[1] });
          expect(running.every((job) => job.lane === 'repo' || job.lane === 'bypass')).toBe(true);
          const repoJobs = running.filter((job) => job.lane === 'repo');
          expect(new Set(repoJobs.map((job) => job.repo)).size).toBe(repoJobs.length);
          expect(running.filter((job) => job.lane === 'bypass').length).toBeLessThanOrEqual(2);
          if (self?.lane === 'bypass') expect(load).toBeLessThan(95);
          const named = new Set<string>();
          for (const job of running) {
            const jobRoots = active.get(job.root);
            expect(jobRoots).toBeDefined();
            for (const key of jobRoots ?? []) {
              expect(named.has(key)).toBe(false);
              named.add(key);
            }
          }
          loadsAtStart.add(load);
        } catch (error) {
          if (failures.length === 0) failures.push(String(error));
          active.set(root, new Set([root, ...extra]));
        }
        await gate.run();
        active.delete(root);
        started.delete(root);
      }, { alsoRoots: extra }));
    }
    load = 94.9;
    for (let completed = 0; completed < jobs.length; completed++) {
      expect(failures).toEqual([]);
      const running = queue.runningJobs()[0];
      expect(running).toBeDefined();
      if (running === undefined) throw new Error('waiting jobs have no running job to release');
      const index = started.get(running.root);
      expect(index).toBeDefined();
      if (index === undefined) throw new Error(`no gate for running root ${running.root}`);
      gates[index].finish();
      await jobs[index];
    }
    expect(failures).toEqual([]);
    expect(loadsAtStart).toEqual(new Set([95, 94.9]));
    expect(active.size).toBe(0);
  });

  it('starts cold builds of different repositories together', async () => {
    const { queue, events } = recordingQueue();
    const a = held();
    const b = held();
    const first = queue.enqueue('cold-build', '/a', a.run);
    const second = queue.enqueue('cold-build', '/b', b.run);
    expect(events).toEqual(['start cold-build /a', 'start cold-build /b']);
    a.finish(); b.finish();
    await Promise.all([first, second]);
  });

  it('runs two worktrees of one repository one at a time when bypass is closed', async () => {
    const { queue, events } = recordingQueue(() => 'repo');
    const a = held();
    const first = queue.enqueue('index', '/a', a.run);
    const second = queue.enqueue('init', '/b', async () => undefined);
    expect(events).toEqual(['start index /a']);
    expect(queue.waiting()).toBe(1);
    a.finish();
    await Promise.all([first, second]);
    expect(events).toEqual(['start index /a', 'end index /a', 'start init /b', 'end init /b']);
  });

  it.each([94.9, 95])('allows bypass below 95 but not at 95 (load %s)', async (load) => {
    const { queue, events } = recordingQueue(() => 'repo', () => load);
    const a = held();
    const b = held();
    const first = queue.enqueue('sync', '/a', a.run);
    const second = queue.enqueue('sync', '/b', b.run);
    expect(events.includes('start sync /b')).toBe(load < 95);
    expect(queue.waiting()).toBe(load < 95 ? 0 : 1);
    a.finish();
    await first;
    b.finish();
    await second;
  });

  it('limits bypass jobs to two across all repositories', async () => {
    const { queue } = recordingQueue((root) => root.startsWith('/a') ? 'a' : 'b', () => 94.9);
    const jobs = Array.from({ length: 6 }, () => held());
    const promises = jobs.map((job, i) => queue.enqueue('sync', i < 3 ? `/a${i}` : `/b${i}`, job.run));
    expect(queue.runningJobs().filter((job) => job.lane === 'repo')).toHaveLength(2);
    expect(queue.runningJobs().filter((job) => job.lane === 'bypass')).toHaveLength(2);
    expect(queue.waiting()).toBe(2);
    jobs.forEach((job) => job.finish());
    await Promise.all(promises);
  });

  it('awards a freed bypass to the earliest queued eligible repository', async () => {
    let load = 94.9;
    const { queue } = recordingQueue((root) => root.slice(0, 2), () => load);
    const a = held(); const b = held(); const bypassA = held(); const bypassB = held();
    const older = held(); const newer = held();
    const jobs = [
      queue.enqueue('sync', '/a1', a.run),
      queue.enqueue('sync', '/b1', b.run),
      queue.enqueue('sync', '/a2', bypassA.run),
      queue.enqueue('sync', '/b2', bypassB.run),
    ];
    load = 95;
    jobs.push(queue.enqueue('sync', '/b3', older.run));
    jobs.push(queue.enqueue('sync', '/a3', newer.run));
    expect(queue.waiting()).toBe(2);
    load = 94.9;
    bypassA.finish();
    await jobs[2];
    expect(queue.runningJobs().find((job) => job.root === '/b3')?.lane).toBe('bypass');
    expect(queue.runningJobs().some((job) => job.root === '/a3')).toBe(false);
    a.finish(); b.finish(); bypassB.finish(); older.finish(); newer.finish();
    await Promise.all(jobs);
  });

  it('excludes alsoRoots across repository and bypass slots', async () => {
    const { queue, events } = recordingQueue((root) => root.slice(0, 2), () => 0);
    const a = held(); const b = held();
    const first = queue.enqueue('seed', '/a1', a.run, { alsoRoots: ['/shared'] });
    const bypass = queue.enqueue('sync', '/a2', b.run);
    const conflicting = queue.enqueue('index', '/b1', async () => undefined, { alsoRoots: ['/shared'] });
    expect(events).toEqual(['start seed /a1', 'start sync /a2']);
    expect(queue.waiting()).toBe(1);
    a.finish();
    await first;
    await conflicting;
    b.finish();
    await bypass;
    expect(events.indexOf('end seed /a1')).toBeLessThan(events.indexOf('start index /b1'));
  });

  it('starts load-blocked work in its repository slot when that slot frees', async () => {
    const { queue } = recordingQueue(() => 'repo', () => 95);
    const a = held(); const b = held();
    const first = queue.enqueue('sync', '/a', a.run);
    const second = queue.enqueue('sync', '/b', b.run);
    expect(queue.waiting()).toBe(1);
    a.finish();
    await first;
    expect(queue.runningJobs()).toEqual([{ id: 2, kind: 'sync', root: '/b', repo: 'repo', lane: 'repo' }]);
    b.finish(); await second;
  });

  it('reports running jobs in id order with their repository and assigned lane', async () => {
    const { queue } = recordingQueue((root) => root.slice(0, 2), () => 0);
    const a = held(); const b = held(); const c = held();
    const first = queue.enqueue('index', '/a1', a.run);
    const second = queue.enqueue('open', '/a2', b.run);
    const third = queue.enqueue('cold-build', '/b1', c.run);
    expect(queue.runningJobs()).toEqual([
      { id: 1, kind: 'index', root: '/a1', repo: '/a', lane: 'repo' },
      { id: 2, kind: 'open', root: '/a2', repo: '/a', lane: 'bypass' },
      { id: 3, kind: 'cold-build', root: '/b1', repo: '/b', lane: 'repo' },
    ]);
    a.finish(); b.finish(); c.finish();
    await Promise.all([first, second, third]);
    expect(queue.runningJobs()).toEqual([]);
  });

  it('prioritizes a waiting short job over a whole-repository job sharing its root', async () => {
    const { queue, events } = recordingQueue(() => 'repo', () => 95);
    const a = held();
    const first = queue.enqueue('index', '/blocker', a.run);
    const whole = queue.enqueue('vacuum', '/project', async () => undefined);
    const short = queue.enqueue('sync', '/project', async () => undefined);
    a.finish();
    await Promise.all([first, whole, short]);
    expect(events.indexOf('end sync /project')).toBeLessThan(events.indexOf('start vacuum /project'));
  });

  it('does not skip a blocked whole-repository head for a later whole job in that repository', async () => {
    const { queue, events } = recordingQueue(() => 'repo', () => 0);
    const a = held();
    const first = queue.enqueue('sync', '/a', a.run);
    const head = queue.enqueue('index', '/a', async () => undefined);
    const later = queue.enqueue('index', '/b', async () => undefined);
    expect(events).toEqual(['start sync /a']);
    a.finish();
    await Promise.all([first, head, later]);
    expect(events.indexOf('start index /a')).toBeLessThan(events.indexOf('start index /b'));
  });

  it('starts a sync of another root beside a running vacuum', async () => {
    const { queue, events } = recordingQueue();
    const vacuum = held();
    const sync = held();
    const a = queue.enqueue('vacuum', '/a', vacuum.run);
    const b = queue.enqueue('sync', '/b', sync.run);
    expect(events).toEqual(['start vacuum /a', 'start sync /b']);
    vacuum.finish();
    sync.finish();
    await Promise.all([a, b]);
  });

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
    await Promise.resolve();
    expect(idle).toBe(false);
    job.finish();
    await done;
    await Promise.resolve();
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
    await Promise.resolve();
    expect(other, 'a root the job does not name is idle at once').toBe(true);
    expect(source, 'the source the seed reads is not idle while the seed runs').toBe(false);
    job.finish();
    await done;
    await Promise.resolve();
    expect(source, 'the source is idle once the seed ended').toBe(true);
  });
});

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

describe('job log lines (builder.log)', () => {
  const at = new Date('2026-10-31T12:00:00.000Z');

  it('writes `<ISO8601> job start <kind> <root>` and `<ISO8601> job end <kind> <root> ok|failed[: msg]`', () => {
    expect(formatJobLine({ edge: 'start', kind: 'cold-build', root: '/w' }, at)).toBe('2026-10-31T12:00:00.000Z job start cold-build /w');
    expect(formatJobLine({ edge: 'end', kind: 'sync', root: '/w', ok: true }, at)).toBe('2026-10-31T12:00:00.000Z job end sync /w ok');
    expect(formatJobLine({ edge: 'end', kind: 'seed', root: '/w', ok: false, error: 'copy failed' }, at))
      .toBe('2026-10-31T12:00:00.000Z job end seed /w failed: copy failed');
  });
});
