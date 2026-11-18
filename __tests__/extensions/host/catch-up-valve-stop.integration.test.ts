/**
 * A WAL valve abort ends the holder's catch-up without a retry, even after ten minutes. A valve error reaches
 * the holder as a plain Error named `WalValveAbortError` (it crosses the job child as a name and message), and
 * `queueCatchUp` re-queues only on `LockUnavailableError`; any other failure is logged once. This covers the
 * catch-up path only. A valve-stopped watch-sync is retried by the watcher (src/sync/watcher.ts) as a generic
 * sync failure: up to MAX_SYNC_FAILURE_RETRIES (5) times, waiting from the debounce doubling to
 * MAX_RETRY_BACKOFF_MS (30 s), then auto-sync degrades; that path is not exercised here. The lock-contention case is the control: it shows the catch-up start counter sees a re-queue
 * (the first retry after 1 s), so the valve case's count of one means no retry was queued.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { LockUnavailableError } from '../../../src/errors';
import { HolderSet } from '../../../src/extensions/host/builder/holder';
import { RebuildFences } from '../../../src/extensions/host/builder/fences';
import { JobQueue } from '../../../src/extensions/host/builder/queue';
import type { JobRunner } from '../../../src/extensions/host/builder/job-runner-type';
import { inProcessJobRunner } from './helpers/in-process-job-runner';

describe('catch-up after a WAL valve stop', { timeout: 60_000 }, () => {
  let base: string;
  let root: string;
  let holders: HolderSet;
  let catchUpStarts: number;
  let logLines: string[];
  let failure: Error;
  let releaseFailure: () => void;

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
    let firstCatchUp = true;
    const gate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    const runner = inProcessJobRunner().runJob;
    const runJob: JobRunner = async (id, spec, onProgress) => {
      if (spec.kind === 'catch-up' && firstCatchUp) {
        firstCatchUp = false;
        await gate;
        throw failure;
      }
      return runner(id, spec, onProgress);
    };
    const queue = new JobQueue({ onEvent: (event) => {
      if (event.kind === 'catch-up' && event.edge === 'start') catchUpStarts += 1;
    } });
    holders = new HolderSet({
      runJob,
      queue,
      fences: new RebuildFences((line) => logLines.push(line)),
      onFreshness: () => undefined,
      log: (line) => logLines.push(line),
      watchOptions: () => ({}),
      openWaitMs: 10_000,
      recoverWaitMs: 1_000,
      ownRetryMs: 50,
      pollMs: 25,
    });
  });

  afterEach(async () => {
    releaseFailure();
    vi.useRealTimers();
    await holders.closeAll();
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('logs a WAL valve abort once and does not retry catch-up over ten minutes', async () => {
    const message = 'WAL checkpoint cannot progress; Aborting to avoid unbounded disk growth.';
    failure = Object.assign(new Error(message), { name: 'WalValveAbortError', code: 'WAL_VALVE_ABORT' });
    expect(await holders.hold(root)).toEqual({ kind: 'held', root });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    releaseFailure();
    await expect(holders.caughtUp(root)).resolves.toBeUndefined();
    expect(catchUpStarts).toBe(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(catchUpStarts).toBe(1);
    const failures = logLines.filter((line) => line.includes('Catch-up sync failed for'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(message);
  });

  it('retries catch-up after lock contention', async () => {
    failure = new LockUnavailableError();
    expect(await holders.hold(root)).toEqual({ kind: 'held', root });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    releaseFailure();
    await expect(holders.caughtUp(root)).resolves.toBeUndefined();
    expect(catchUpStarts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(catchUpStarts).toBe(2);
  });
});
