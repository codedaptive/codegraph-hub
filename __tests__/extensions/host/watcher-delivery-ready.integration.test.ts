import { inProcessJobRunner } from './helpers/in-process-job-runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import CodeGraph from '../../../src/index';
import { codeGraphDirNameFor } from '../../../src/directory';
import { __setFsWatchForTests } from '../../../src/sync/watcher';
import { HolderSet } from '../../../src/extensions/host/builder/holder';
import { RebuildFences } from '../../../src/extensions/host/builder/fences';
import { JobQueue } from '../../../src/extensions/host/builder/queue';

type Listener = (event: string, filename: string | Buffer | null) => void;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('macOS watcher delivery readiness', () => {
  let base: string;
  let root: string;
  let listener: Listener;
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
    await holders?.closeAll();
    vi.useRealTimers();
    holders = undefined;
    __setFsWatchForTests(null);
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  });

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
    return { queue, jobs: () => recorded.mock.calls.map((call) => call[0]), held: holders = new HolderSet({ runJob: inProcessJobRunner().runJob,
      queue,
      fences: new RebuildFences(() => undefined),
      onFreshness: () => undefined,
      log: () => undefined,
      watchOptions: () => ({}),
      openWaitMs: 10_000,
      recoverWaitMs: 1_000,
      ownRetryMs: 50,
      pollMs: 1_000,
    }) };
  }

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

  it.runIf(process.platform === 'darwin')('release before delivery settles caughtUp and never queues catch-up', async () => {
    const { jobs, held } = await setupHolder();
    expect(await held.hold(root)).toEqual({ kind: 'held', root });
    const caughtUp = held.caughtUp(root);
    await held.release(root);
    await caughtUp;
    expect(jobs()).not.toContain('catch-up');
  });

  it.runIf(process.platform === 'darwin')('indexes an unreported edit made before stream delivery during the first catch-up', async () => {
    const { held, queue } = await setupHolder();
    expect(await held.hold(root)).toEqual({ kind: 'held', root });
    // Wait for queued work to finish while the probe holds catch-up back. The probe event then
    // queues the scan after the unreported write.
    await queue.whenIdle();
    fs.writeFileSync(path.join(root, 'src/gap.ts'), 'export const gap = 1;\n');
    const dataDir = codeGraphDirNameFor(root);
    const probeName = fs.readdirSync(path.join(root, dataDir)).find((name) => name.startsWith('.codegraph-watch-probe-'));
    expect(probeName).toBeDefined();
    listener('change', path.join(dataDir, probeName ?? ''));
    await held.caughtUp(root);
    const graph = CodeGraph.openSync(root, { readOnly: true });
    try { expect(graph.getFile('src/gap.ts')).toEqual(expect.objectContaining({ path: 'src/gap.ts' })); } finally { graph.close(); }
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
});
