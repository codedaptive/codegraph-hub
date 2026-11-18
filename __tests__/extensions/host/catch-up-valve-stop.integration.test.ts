/**
 * What the builder's holder does when a catch-up is stopped by the WAL valve: the retry timing (5 s, doubling per
 * stop in a row, capped at 5 min), the builder's stderr diagnostic line for each stop, how the retries end (a finished catch-up,
 * a release of the hold, a retry ended at a job limit) and that `caughtUp` settles at the first stop. Controls:
 * lock contention keeps its 1 s doubling retry (and does not break a valve run), and any other failure is logged
 * once and not retried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { LockUnavailableError } from '../../../src/errors';
import { HolderSet } from '../../../src/extensions/host/builder/holder';
import { JobEndedError } from '../../../src/extensions/host/builder/job-ended-error';
import { RebuildFences } from '../../../src/extensions/host/builder/fences';
import { JobQueue } from '../../../src/extensions/host/builder/queue';
import type { JobRunner } from '../../../src/extensions/host/builder/job-runner-type';
import { inProcessJobRunner } from './helpers/in-process-job-runner';

describe('catch-up after a WAL valve stop', { timeout: 60_000 }, () => {
  let base: string;
  let root: string;
  let holders: HolderSet;
  let queue: JobQueue;
  let catchUpStarts: number;
  let logLines: string[];
  let failureFor: (attempt: number) => Error | undefined;
  let releaseFailure: () => void;
  let reholdGate: Promise<void>;
  let releaseRehold: () => void;
  const valve = () => Object.assign(new Error('checkpoint pinned'), { name: 'WalValveAbortError' });

  beforeEach(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-catch-up-valve-')));
    root = path.join(base, 'project');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a() { return 1; }\n');
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(base, 'state'));
    vi.stubEnv('CODEGRAPH_NO_WATCH', '1');
    const init = await CodeGraph.init(root);
    try { await init.indexAll(); } finally { init.close(); }

    catchUpStarts = 0;
    logLines = [];
    failureFor = () => undefined;
    let attempts = 0;
    const gate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    reholdGate = Promise.resolve();
    releaseRehold = () => {};
    const runner = inProcessJobRunner().runJob;
    const runJob: JobRunner = async (id, spec, onProgress) => {
      if (spec.kind === 'catch-up') {
        attempts += 1;
        if (attempts === 1) await gate;
        await reholdGate;
        const failure = failureFor(attempts);
        if (failure) throw failure;
      }
      return runner(id, spec, onProgress);
    };
    queue = new JobQueue({ onEvent: (event) => {
      if (event.kind === 'catch-up' && event.edge === 'start') catchUpStarts += 1;
    } });
    holders = new HolderSet({
      runJob, queue,
      fences: new RebuildFences((line) => logLines.push(line)),
      onFreshness: () => undefined,
      log: (line) => logLines.push(line),
      watchOptions: () => ({}),
      openWaitMs: 10_000, recoverWaitMs: 1_000, ownRetryMs: 50, pollMs: 25,
    });
  });

  afterEach(async () => {
    releaseFailure();
    releaseRehold();
    vi.useRealTimers();
    await holders.closeAll();
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  });

  async function start() {
    expect(await holders.hold(root)).toEqual({ kind: 'held', root });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-18T12:00:00.000Z'));
    releaseFailure();
    await holders.caughtUp(root);
    expect(catchUpStarts).toBe(1);
  }

  it('retries a valve stop at five seconds, not before', async () => {
    failureFor = (n) => n === 1 ? valve() : undefined;
    await start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(catchUpStarts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(catchUpStarts).toBe(2);
  });

  it('doubles consecutive valve waits and caps them at five minutes', async () => {
    failureFor = () => valve();
    await start();
    for (const [wait, before] of [[5_000, 1], [10_000, 2], [20_000, 3], [40_000, 4],
      [80_000, 5], [160_000, 6], [300_000, 7], [300_000, 8]]) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(catchUpStarts).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(catchUpStarts).toBe(before + 1);
    }
  });

  it('logs each valve stop once with the exact next attempt and no generic failure', async () => {
    failureFor = () => valve();
    await start();
    for (const wait of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000]) {
      await vi.advanceTimersByTimeAsync(wait);
    }
    expect(logLines.filter((line) => line.includes('stopped by the WAL valve'))).toEqual([
      `Catch-up of ${root} stopped by the WAL valve: checkpoint pinned; next attempt in 5 s, at 2026-11-18T12:00:05.000Z`,
      `Catch-up of ${root} stopped by the WAL valve: checkpoint pinned; next attempt in 10 s, at 2026-11-18T12:00:15.000Z`,
      `Catch-up of ${root} stopped by the WAL valve: checkpoint pinned; next attempt in 20 s, at 2026-11-18T12:00:35.000Z`,
      `Catch-up of ${root} stopped by the WAL valve: checkpoint pinned; next attempt in 40 s, at 2026-11-18T12:01:15.000Z`,
      `Catch-up of ${root} stopped by the WAL valve: checkpoint pinned; next attempt in 80 s, at 2026-11-18T12:02:35.000Z`,
      `Catch-up of ${root} stopped by the WAL valve: checkpoint pinned; next attempt in 160 s, at 2026-11-18T12:05:15.000Z`,
      `Catch-up of ${root} stopped by the WAL valve: checkpoint pinned; next attempt in 300 s, at 2026-11-18T12:10:15.000Z`,
      `Catch-up of ${root} stopped by the WAL valve: checkpoint pinned; next attempt in 300 s, at 2026-11-18T12:15:15.000Z`,
    ]);
    expect(logLines.filter((line) => line.includes('Catch-up sync failed for'))).toEqual([]);
  });

  it('ends the retries when a catch-up finishes after two valve stops', async () => {
    failureFor = (n) => n <= 2 ? valve() : undefined;
    await start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(catchUpStarts).toBe(3);
    await queue.whenRootIdle(root);
    expect(logLines.filter((line) => line.includes('stopped by the WAL valve'))).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(catchUpStarts).toBe(3);
    expect(logLines.filter((line) => line.includes('stopped by the WAL valve'))).toHaveLength(2);
  });

  it.each([
    ['after the previous catch-up finishes', true, 4],
    ['after release with a retry pending', false, 3],
  ])('starts a new hold at a five-second valve wait %s', async (_description, finishCatchUp, newHoldStart) => {
    failureFor = (n) => n <= 2 ? valve() : undefined;
    await start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(catchUpStarts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(catchUpStarts).toBe(2);
    expect(logLines.filter((line) => line.includes('stopped by the WAL valve')).at(-1)).toBe(
      `Catch-up of ${root} stopped by the WAL valve: checkpoint pinned; next attempt in 10 s, at 2026-11-18T12:00:15.000Z`,
    );
    if (finishCatchUp) {
      await vi.advanceTimersByTimeAsync(9_999);
      expect(catchUpStarts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(catchUpStarts).toBe(3);
      await queue.whenRootIdle(root);
    }
    await holders.release(root);
    reholdGate = new Promise<void>((resolve) => { releaseRehold = resolve; });
    failureFor = (n) => n === newHoldStart ? valve() : undefined;
    vi.useRealTimers();
    expect(await holders.hold(root)).toEqual({ kind: 'held', root });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-18T12:00:00.000Z'));
    releaseRehold();
    await holders.caughtUp(root);
    expect(catchUpStarts).toBe(newHoldStart);
    expect(logLines.filter((line) => line.includes('stopped by the WAL valve')).at(-1)).toBe(
      `Catch-up of ${root} stopped by the WAL valve: checkpoint pinned; next attempt in 5 s, at 2026-11-18T12:00:05.000Z`,
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(catchUpStarts).toBe(newHoldStart);
    await vi.advanceTimersByTimeAsync(1);
    expect(catchUpStarts).toBe(newHoldStart + 1);
  });

  it('cancels the pending valve retry when the hold is released', async () => {
    failureFor = () => valve();
    await start();
    expect(vi.getTimerCount()).toBe(1);
    await holders.release(root);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(catchUpStarts).toBe(1);
  });

  it('stops after a retry ends at a job limit and logs the failure', async () => {
    const ended = new JobEndedError(root, 'catch-up', 'time');
    failureFor = (n) => n === 1 ? valve() : ended;
    await start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(catchUpStarts).toBe(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(catchUpStarts).toBe(2);
    expect(logLines.filter((line) => line.includes('Catch-up sync failed for')))
      .toEqual([`Catch-up sync failed for ${root}: ${ended.message}`]);
  });

  it('keeps lock contention retrying at one then two seconds', async () => {
    failureFor = (n) => n <= 2 ? new LockUnavailableError() : undefined;
    await start();
    await vi.advanceTimersByTimeAsync(999);
    expect(catchUpStarts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(catchUpStarts).toBe(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(catchUpStarts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(catchUpStarts).toBe(3);
  });

  it('logs another error once and does not retry', async () => {
    failureFor = () => new Error('boom');
    await start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(catchUpStarts).toBe(1);
    expect(logLines.filter((line) => line.includes('Catch-up sync failed for')))
      .toEqual([`Catch-up sync failed for ${root}: boom`]);
  });

  it('keeps the valve run across an intervening lock failure', async () => {
    failureFor = (n) => n === 2 ? new LockUnavailableError() : valve();
    await start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(catchUpStarts).toBe(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(catchUpStarts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(catchUpStarts).toBe(3);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(catchUpStarts).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(catchUpStarts).toBe(4);
  });

  it('settles caughtUp on the first valve stop without waiting for the retry', async () => {
    failureFor = () => valve();
    await start();
    expect(catchUpStarts).toBe(1);
    expect(Date.now()).toBe(new Date('2026-11-18T12:00:00.000Z').getTime());
  });
});
