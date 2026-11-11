import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import CodeGraph from '../../../src/index';
import { codeGraphDirNameFor } from '../../../src/directory';
import { FileWatcher, __setFsWatchForTests, type WatchOptions } from '../../../src/sync/watcher';
import { HolderSet } from '../../../src/extensions/host/builder/holder';
import { RebuildFences } from '../../../src/extensions/host/builder/fences';
import { JobQueue } from '../../../src/extensions/host/builder/queue';

type ProbeOptions = WatchOptions & { deliveryProbe?: boolean; deliveryProbeMaxMs?: number };
type Listener = (event: string, filename: string | Buffer | null) => void;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('macOS watcher delivery readiness', () => {
  let base: string;
  let root: string;
  let listener: Listener;
  let watcher: FileWatcher | undefined;
  let holders: HolderSet | undefined;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-delivery-ready-')));
    root = path.join(base, 'project');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(base, 'state'));
    vi.stubEnv('CODEGRAPH_DIR', '.codegraph');
    vi.stubEnv('CODEGRAPH_NO_WATCH', '');
    __setFsWatchForTests(((dir: fs.PathLike, _options: unknown, callback: Listener) => {
      if (String(dir) === root) listener = callback;
      const stream = new EventEmitter() as fs.FSWatcher;
      stream.close = () => undefined;
      return stream;
    }) as unknown as typeof fs.watch);
  });

  afterEach(async () => {
    watcher?.stop();
    await holders?.closeAll();
    vi.useRealTimers();
    watcher = undefined;
    holders = undefined;
    __setFsWatchForTests(null);
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  });

  function newWatcher(options: ProbeOptions = {}, sync = async (_paths?: string[]) => ({ filesChanged: 0, durationMs: 0 })): FileWatcher {
    watcher = new FileWatcher(root, sync, options);
    return watcher;
  }

  function probe(dir: string): string {
    const found = fs.readdirSync(dir).filter((name) => name.startsWith('.codegraph-watch-probe-'));
    expect(found).toHaveLength(1);
    return path.relative(root, path.join(dir, found[0]));
  }

  async function setupHolder(): Promise<{ jobs: () => string[]; held: HolderSet; queue: JobQueue }> {
    const graph = await CodeGraph.init(root);
    graph.close();
    const queue = new JobQueue();
    const recorded = vi.spyOn(queue, 'enqueue');
    return { queue, jobs: () => recorded.mock.calls.map((call) => call[0]), held: holders = new HolderSet({
      queue,
      fences: new RebuildFences(queue, () => undefined),
      onFreshness: () => undefined,
      log: () => undefined,
      watchOptions: () => ({}),
      openWaitMs: 10_000,
      recoverWaitMs: 1_000,
      ownRetryMs: 50,
      pollMs: 1_000,
    }) };
  }

  it.runIf(process.platform === 'darwin')('waits for the probe event before readiness, then delivers a late source event to sync', async () => {
    fs.mkdirSync(path.join(root, codeGraphDirNameFor(root)));
    let synced: (paths: string[] | undefined) => void = () => undefined;
    const syncCall = new Promise<string[] | undefined>((resolve) => { synced = resolve; });
    const w = newWatcher({ deliveryProbe: true, debounceMs: 1 }, async (paths) => {
      synced(paths);
      return { filesChanged: 1, durationMs: 0 };
    });
    expect(w.start()).toBe(true);
    let ready = false;
    const waiting = w.waitUntilReady().then(() => { ready = true; });
    await tick();
    expect(ready).toBe(false);
    const rel = probe(path.join(root, codeGraphDirNameFor(root)));
    listener('change', rel);
    await waiting;
    expect(fs.existsSync(path.join(root, rel))).toBe(false);
    fs.writeFileSync(path.join(root, 'src/late.ts'), 'export const late = 1;');
    listener('change', 'src/late.ts');
    expect(await syncCall).toContain('src/late.ts');
  });

  it.runIf(process.platform === 'darwin')('queues holder catch-up only after delivery is confirmed', async () => {
    const { jobs, held } = await setupHolder();
    expect(await held.hold(root)).toEqual({ kind: 'held', root });
    const caughtUp = held.caughtUp(root);
    await tick();
    expect(jobs()).toContain('open');
    expect(jobs()).not.toContain('catch-up');
    listener('change', probe(path.join(root, codeGraphDirNameFor(root))));
    await caughtUp;
    expect(jobs()).toContain('catch-up');
  });

  it.runIf(process.platform === 'darwin')('falls back to ready at the probe bound without delivery', async () => {
    fs.mkdirSync(path.join(root, codeGraphDirNameFor(root)));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const w = newWatcher({ deliveryProbe: true, deliveryProbeMaxMs: 50 });
    expect(w.start()).toBe(true);
    let ready = false;
    const waiting = w.waitUntilReady().then(() => { ready = true; });
    await vi.advanceTimersByTimeAsync(49);
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(ready).toBe(true);
  });

  it.runIf(process.platform === 'darwin')('removes the probe on stop without settling its waiter', async () => {
    fs.mkdirSync(path.join(root, codeGraphDirNameFor(root)));
    const w = newWatcher({ deliveryProbe: true });
    expect(w.start()).toBe(true);
    let ready = false;
    const waiting = w.waitUntilReady().then(() => { ready = true; });
    const rel = probe(path.join(root, codeGraphDirNameFor(root)));
    w.stop();
    await tick();
    expect(fs.existsSync(path.join(root, rel))).toBe(false);
    expect(ready).toBe(false);
    expect(w.start()).toBe(true);
    listener('change', probe(path.join(root, codeGraphDirNameFor(root))));
    await waiting;
  });

  it.runIf(process.platform === 'darwin')('release before delivery settles caughtUp and never queues catch-up', async () => {
    const { jobs, held } = await setupHolder();
    expect(await held.hold(root)).toEqual({ kind: 'held', root });
    const caughtUp = held.caughtUp(root);
    await held.release(root);
    await caughtUp;
    expect(jobs()).not.toContain('catch-up');
  });

  it.runIf(process.platform === 'darwin')('preserves source events pending from installation through probe delivery', async () => {
    fs.mkdirSync(path.join(root, codeGraphDirNameFor(root)));
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;');
    const w = newWatcher({ deliveryProbe: true, debounceMs: 10_000 });
    expect(w.start()).toBe(true);
    listener('change', 'src/a.ts');
    expect(w.getPendingFiles().map((entry) => entry.path)).toContain('src/a.ts');
    const waiting = w.waitUntilReady();
    listener('change', probe(path.join(root, codeGraphDirNameFor(root))));
    await waiting;
    expect(w.getPendingFiles().map((entry) => entry.path)).toContain('src/a.ts');
  });

  it.runIf(process.platform === 'darwin')('resolves a pre-stop waiter only after the restarted probe is delivered', async () => {
    fs.mkdirSync(path.join(root, codeGraphDirNameFor(root)));
    const w = newWatcher({ deliveryProbe: true });
    let ready = false;
    const waiting = w.waitUntilReady().then(() => { ready = true; });
    expect(w.start()).toBe(true);
    w.stop();
    expect(w.start()).toBe(true);
    await tick();
    expect(ready).toBe(false);
    listener('change', probe(path.join(root, codeGraphDirNameFor(root))));
    await waiting;
    expect(ready).toBe(true);
  });

  it.runIf(process.platform === 'darwin')('places the probe at the root when the data directory is a symlink', async () => {
    fs.mkdirSync(path.join(base, 'outside'));
    fs.symlinkSync(path.join(base, 'outside'), path.join(root, codeGraphDirNameFor(root)), 'dir');
    const w = newWatcher({ deliveryProbe: true });
    expect(w.start()).toBe(true);
    const rel = probe(root);
    expect(fs.readdirSync(path.join(base, 'outside')).filter((name) => name.startsWith('.codegraph-watch-probe-'))).toEqual([]);
    const waiting = w.waitUntilReady();
    listener('change', rel);
    await waiting;
    expect(fs.existsSync(path.join(root, rel))).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('indexes an unreported edit made before stream delivery during the first catch-up', async () => {
    const { held, queue } = await setupHolder();
    expect(await held.hold(root)).toEqual({ kind: 'held', root });
    // At base, queue idle means catch-up has scanned before the unreported write. With delivery-gated
    // catch-up, only open has run; the probe event queues the scan after the write.
    await queue.whenIdle();
    fs.writeFileSync(path.join(root, 'src/gap.ts'), 'export const gap = 1;\n');
    const dataDir = codeGraphDirNameFor(root);
    const probeName = fs.readdirSync(path.join(root, dataDir)).find((name) => name.startsWith('.codegraph-watch-probe-'));
    if (probeName) listener('change', path.join(dataDir, probeName));
    await held.caughtUp(root);
    expect(held.ownedGraph(root)?.getFile('src/gap.ts')).toEqual(expect.objectContaining({ path: 'src/gap.ts' }));
  });

  it.runIf(process.platform === 'darwin')('creates the probe in the configured data directory', async () => {
    vi.stubEnv('CODEGRAPH_DIR', '.cg-custom');
    fs.mkdirSync(path.join(root, '.cg-custom'));
    const w = newWatcher({ deliveryProbe: true });
    expect(w.start()).toBe(true);
    const rel = probe(path.join(root, '.cg-custom'));
    const waiting = w.waitUntilReady();
    listener('change', rel);
    await waiting;
    expect(fs.existsSync(path.join(root, rel))).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('leaves a replacement file at the probe path untouched on stop', () => {
    fs.mkdirSync(path.join(root, codeGraphDirNameFor(root)));
    const w = newWatcher({ deliveryProbe: true });
    expect(w.start()).toBe(true);
    const full = path.join(root, probe(path.join(root, codeGraphDirNameFor(root))));
    fs.unlinkSync(full);
    fs.writeFileSync(full, 'replacement');
    w.stop();
    expect(fs.readFileSync(full, 'utf8')).toBe('replacement');
  });

  it.runIf(process.platform === 'darwin')('does not probe without opt-in and is ready at installation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const dir = path.join(root, codeGraphDirNameFor(root));
    fs.mkdirSync(dir);
    const w = newWatcher();
    expect(w.start()).toBe(true);
    let ready = false;
    void w.waitUntilReady().then(() => { ready = true; }, () => undefined);
    await Promise.resolve();
    expect(ready).toBe(true);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.codegraph-watch-probe-'))).toEqual([]);
  });

  it.runIf(process.platform === 'darwin')('clears delivery-related timers when a held root is released', async () => {
    const { held } = await setupHolder();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const before = vi.getTimerCount();
    expect(await held.hold(root)).toEqual({ kind: 'held', root });
    const caughtUp = held.caughtUp(root);
    await held.release(root);
    await caughtUp;
    expect(vi.getTimerCount()).toBe(before);
  });

  it.runIf(process.platform === 'darwin')('does not confirm delivery for an unrelated .codegraph-other event', async () => {
    fs.mkdirSync(path.join(root, codeGraphDirNameFor(root)));
    const w = newWatcher({ deliveryProbe: true });
    expect(w.start()).toBe(true);
    let ready = false;
    const waiting = w.waitUntilReady().then(() => { ready = true; });
    listener('change', '.codegraph-other');
    await tick();
    expect(ready).toBe(false);
    listener('change', probe(path.join(root, codeGraphDirNameFor(root))));
    await waiting;
    expect(ready).toBe(true);
  });
});
