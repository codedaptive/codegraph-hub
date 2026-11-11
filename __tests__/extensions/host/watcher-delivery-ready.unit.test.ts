import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { codeGraphDirNameFor } from '../../../src/directory';
import { FileWatcher, __setFsWatchForTests, type WatchOptions } from '../../../src/sync/watcher';
import { deliveryProbeGate } from '../../../src/extensions/host/sync/delivery-probe';

type Listener = (event: string, filename: string | Buffer | null) => void;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('macOS watcher delivery readiness', () => {
  let base: string;
  let root: string;
  let listener: Listener;
  let watcher: FileWatcher | undefined;

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
    vi.useRealTimers();
    watcher = undefined;
    __setFsWatchForTests(null);
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  });

  function newWatcher(options: WatchOptions = {}, sync = async (_paths?: string[]) => ({ filesChanged: 0, durationMs: 0 })): FileWatcher {
    watcher = new FileWatcher(root, sync, options);
    return watcher;
  }

  function probe(dir: string): string {
    const found = fs.readdirSync(dir).filter((name) => name.startsWith('.codegraph-watch-probe-'));
    expect(found).toHaveLength(1);
    return path.relative(root, path.join(dir, found[0]));
  }

  it.runIf(process.platform === 'darwin')('waits for the probe event before readiness, then delivers a late source event to sync', async () => {
    fs.mkdirSync(path.join(root, codeGraphDirNameFor(root)));
    let synced: (paths: string[] | undefined) => void = () => undefined;
    const syncCall = new Promise<string[] | undefined>((resolve) => { synced = resolve; });
    const w = newWatcher({ readinessGate: deliveryProbeGate(), debounceMs: 1 }, async (paths) => {
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

  it.runIf(process.platform === 'darwin')('falls back to ready at the probe bound without delivery', async () => {
    fs.mkdirSync(path.join(root, codeGraphDirNameFor(root)));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const w = newWatcher({ readinessGate: deliveryProbeGate({ maxMs: 50 }) });
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
    const w = newWatcher({ readinessGate: deliveryProbeGate() });
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

  it.runIf(process.platform === 'darwin')('preserves source events pending from installation through probe delivery', async () => {
    fs.mkdirSync(path.join(root, codeGraphDirNameFor(root)));
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;');
    const w = newWatcher({ readinessGate: deliveryProbeGate(), debounceMs: 10_000 });
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
    const w = newWatcher({ readinessGate: deliveryProbeGate() });
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
    const w = newWatcher({ readinessGate: deliveryProbeGate() });
    expect(w.start()).toBe(true);
    const rel = probe(root);
    expect(fs.readdirSync(path.join(base, 'outside')).filter((name) => name.startsWith('.codegraph-watch-probe-'))).toEqual([]);
    const waiting = w.waitUntilReady();
    listener('change', rel);
    await waiting;
    expect(fs.existsSync(path.join(root, rel))).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('creates the probe in the configured data directory', async () => {
    vi.stubEnv('CODEGRAPH_DIR', '.cg-custom');
    fs.mkdirSync(path.join(root, '.cg-custom'));
    const w = newWatcher({ readinessGate: deliveryProbeGate() });
    expect(w.start()).toBe(true);
    const rel = probe(path.join(root, '.cg-custom'));
    const waiting = w.waitUntilReady();
    listener('change', rel);
    await waiting;
    expect(fs.existsSync(path.join(root, rel))).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('leaves a replacement file at the probe path untouched on stop', () => {
    fs.mkdirSync(path.join(root, codeGraphDirNameFor(root)));
    const w = newWatcher({ readinessGate: deliveryProbeGate() });
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

  it.runIf(process.platform === 'darwin')('does not confirm delivery for an unrelated .codegraph-other event', async () => {
    fs.mkdirSync(path.join(root, codeGraphDirNameFor(root)));
    const w = newWatcher({ readinessGate: deliveryProbeGate() });
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

  it.runIf(process.platform === 'darwin')('swallows a normalized event claimed by a readiness gate', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    fs.writeFileSync(path.join(root, 'src/claimed.ts'), 'export const claimed = 1;');
    fs.writeFileSync(path.join(root, 'src/other.ts'), 'export const other = 1;');
    const sync = vi.fn(async (_paths?: string[]) => ({ filesChanged: 0, durationMs: 0 }));
    const w = newWatcher({
      debounceMs: 50,
      readinessGate: () => ({
        start: (confirm: () => void) => confirm(),
        claims: (relativePath: string) => relativePath === 'src/claimed.ts',
        stop: () => undefined,
      }),
    }, sync);
    expect(w.start()).toBe(true);
    listener('change', 'src/dir/../claimed.ts');
    expect(w.getPendingFiles()).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(sync).not.toHaveBeenCalled();
    listener('change', 'src/other.ts');
    expect(w.getPendingFiles().map((entry) => entry.path)).toContain('src/other.ts');
  });
});
