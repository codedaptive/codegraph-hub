import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JobEndedError } from '../../../src/extensions/host/builder/job-ended-error';
import { FileWatcher, __emitWatchEventForTests } from '../../../src/sync/watcher';

describe('watcher sync when a builder job has ended', () => {
  let root: string;
  let watcher: FileWatcher | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-watch-ended-'));
    fs.writeFileSync(path.join(root, 'source.ts'), 'export const value = 1;');
    vi.stubEnv('CODEGRAPH_NO_WATCH', '');
    vi.useFakeTimers();
  });

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function failFirstSync(error: Error) {
    const sync = vi.fn().mockRejectedValue(error);
    watcher = new FileWatcher(root, sync, { inertForTests: true, debounceMs: 100 });
    expect(watcher.start()).toBe(true);
    await watcher.waitUntilReady();
    __emitWatchEventForTests(root, 'source.ts');
    await vi.advanceTimersByTimeAsync(100);
    expect(sync).toHaveBeenCalledTimes(1);
    return { watcher, sync };
  }

  it('degrades on the first failure of a real ended builder job', async () => {
    const { watcher } = await failFirstSync(new JobEndedError(root, 'watch-sync', 'time'));
    expect(watcher.isDegraded()).toBe(true);
  });

  it('recognizes an ended job by error name without requiring its class', async () => {
    const error = Object.assign(new Error('job stopped at its limit'), { name: 'JobEndedError' });
    const { watcher } = await failFirstSync(error);
    expect(watcher.isDegraded()).toBe(true);
  });

  it('reports the ended job message in the degraded reason', async () => {
    const error = new JobEndedError(root, 'watch-sync', 'rss');
    const { watcher } = await failFirstSync(error);
    expect(watcher.getDegradedReason()).toContain(error.message);
  });

  it('does not advise codegraph sync for an ended job', async () => {
    const { watcher } = await failFirstSync(new JobEndedError(root, 'watch-sync', 'time'));
    expect(watcher.getDegradedReason()).toEqual(expect.any(String));
    expect(watcher.getDegradedReason()).not.toContain('codegraph sync');
  });

  it('does not retry an ended job', async () => {
    const { sync } = await failFirstSync(new JobEndedError(root, 'watch-sync', 'time'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('does not degrade after one ordinary sync failure', async () => {
    const { watcher } = await failFirstSync(new Error('transient sync failure'));
    expect(watcher.isDegraded()).toBe(false);
    expect(watcher.getDegradedReason()).toBeNull();
  });
});
