/**
 * Two units of src/extensions/host/builder/holder.ts, both on real indexes and real files in temp dirs.
 *
 * `isIndexedFileStateCurrent`: the filter the builder's watcher gets on Windows to drop NTFS last-access
 * notifications, a copy of `CodeGraph`'s private check built on `getFile`. The predicate itself is
 * platform-neutral, so it runs here on POSIX. That the watcher is given it only on win32 is not exercised: no
 * Windows machine runs this suite.
 *
 * `HolderSet` catch-up readiness publication: the catch-up that ends a hold's first sync publishes the `ready`
 * flag of `writer.pid` through `markWriterReady`. That export is a partial mock (every other export is the real
 * one) that throws while `writer.failWith` is set, so a publish failure is exercised without a real write
 * failure. While `writer.noop` is set it returns without calling the real export, so a publication that
 * silently writes nothing (the record stays not ready) is exercised too. The contract: `caughtUp` never rejects
 * and logs the failure; a later `caughtUp` retries the publication; a publication that returns without making
 * the record ready leaves the retry eligible; the normal path publishes once; a catch-up that waited out lock
 * contention and then failed to publish raises no unhandled rejection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { HolderSet, isIndexedFileStateCurrent } from '../../../src/extensions/host/builder/holder';
import { RebuildFences } from '../../../src/extensions/host/builder/fences';
import { JobQueue } from '../../../src/extensions/host/builder/queue';
import * as writerLock from '../../../src/mcp/writer-lock';

/**
 * While `failWith` is set, the mocked `markWriterReady` throws it. While `noop` is set, it returns without calling
 * the real export, so nothing is written. Hoisted so the mock factory can read them.
 */
const writer = vi.hoisted(() => ({ failWith: null as Error | null, noop: false }));

vi.mock('../../../src/mcp/writer-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/mcp/writer-lock')>();
  return {
    ...actual,
    markWriterReady: vi.fn((projectRoot: string) => {
      if (writer.failWith) throw writer.failWith;
      if (writer.noop) return;
      actual.markWriterReady(projectRoot);
    }),
  };
});

describe('isIndexedFileStateCurrent', { timeout: 60_000 }, () => {
  let root: string;
  let cg: CodeGraph;
  const file = (rel: string): string => path.join(root, rel);

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-builder-holder-')));
    fs.mkdirSync(file('src'), { recursive: true });
    fs.writeFileSync(file('src/a.ts'), 'export function a() { return 1; }\n');
    fs.writeFileSync(file('src/gone.ts'), 'export function gone() { return 2; }\n');
    const init = await CodeGraph.init(root);
    try { await init.indexAll(); } finally { init.close(); }
    cg = CodeGraph.openSync(root, { readOnly: true });
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is true for an indexed file whose size and mtime still match the index', () => {
    expect(cg.getFile('src/a.ts')).not.toBeNull();
    expect(isIndexedFileStateCurrent(cg, root, 'src/a.ts')).toBe(true);
  });

  it('is false once the mtime moved', () => {
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file('src/a.ts'), later, later);
    expect(isIndexedFileStateCurrent(cg, root, 'src/a.ts')).toBe(false);
  });

  it('is false once the size changed, even with the mtime put back', () => {
    const before = fs.statSync(file('src/a.ts'));
    fs.appendFileSync(file('src/a.ts'), '// more\n');
    fs.utimesSync(file('src/a.ts'), before.atime, before.mtime);
    expect(isIndexedFileStateCurrent(cg, root, 'src/a.ts')).toBe(false);
  });

  it('is false for a file the index does not track', () => {
    fs.writeFileSync(file('src/untracked.ts'), 'export const u = 1;\n');
    expect(isIndexedFileStateCurrent(cg, root, 'src/untracked.ts')).toBe(false);
  });

  it('is false for an indexed file that is now missing, so its removal reaches the sync', () => {
    expect(cg.getFile('src/gone.ts')).not.toBeNull();
    fs.rmSync(file('src/gone.ts'));
    expect(isIndexedFileStateCurrent(cg, root, 'src/gone.ts')).toBe(false);
  });

  it('is false when the graph is gone or cannot be read', () => {
    expect(isIndexedFileStateCurrent(null, root, 'src/a.ts')).toBe(false);
    const throwing = { getFile: () => { throw new Error('closed'); } };
    expect(isIndexedFileStateCurrent(throwing, root, 'src/a.ts')).toBe(false);
  });
});

describe('HolderSet catch-up readiness publication', { timeout: 60_000 }, () => {
  const publishFailure = 'readiness publish refused by the test';
  let base: string;
  let root: string;
  let logLines: string[];
  let holders: HolderSet;

  /** Polls every 25 ms until `ready()` holds; throws after `ms`. */
  async function waitUntil(ready: () => boolean, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  beforeEach(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-builder-holder-ready-')));
    root = path.join(base, 'project');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a() { return 1; }\n');
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(base, 'state'));
    vi.stubEnv('CODEGRAPH_NO_WATCH', '1');
    const init = await CodeGraph.init(root);
    try { await init.indexAll(); } finally { init.close(); }
    writer.failWith = null;
    writer.noop = false;
    vi.mocked(writerLock.markWriterReady).mockClear();
    logLines = [];
    const queue = new JobQueue();
    holders = new HolderSet({
      queue,
      fences: new RebuildFences(queue, (line) => logLines.push(line)),
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
    await holders.closeAll();
    writer.failWith = null;
    writer.noop = false;
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('resolves caughtUp when publishing readiness throws, and logs the error', async () => {
    writer.failWith = new Error(publishFailure);
    expect(await holders.hold(root)).toEqual({ kind: 'held', root });
    await expect(holders.caughtUp(root)).resolves.toBeUndefined();
    expect(logLines.some((line) => line.includes(publishFailure))).toBe(true);
  });

  it('retries publishing readiness on a later caughtUp, and the record is ready once that succeeds', async () => {
    writer.failWith = new Error(publishFailure);
    expect(await holders.hold(root)).toEqual({ kind: 'held', root });
    await holders.caughtUp(root).catch(() => undefined);
    expect(writerLock.readWriterLock(root)?.ready).not.toBe(true);

    writer.failWith = null;
    await holders.caughtUp(root).catch(() => undefined);
    expect(writerLock.readWriterLock(root)?.ready).toBe(true);
  });

  it('a publication that returns without making the record ready leaves the retry eligible, and a later caughtUp makes the record ready', async () => {
    writer.failWith = new Error(publishFailure);
    expect(await holders.hold(root)).toEqual({ kind: 'held', root });
    await expect(holders.caughtUp(root)).resolves.toBeUndefined();

    writer.failWith = null;
    writer.noop = true;
    await expect(holders.caughtUp(root)).resolves.toBeUndefined();
    expect(writerLock.readWriterLock(root)?.ready).not.toBe(true);

    writer.noop = false;
    await expect(holders.caughtUp(root)).resolves.toBeUndefined();
    expect(writerLock.readWriterLock(root)?.ready).toBe(true);
  });

  it('publishes readiness once on the normal path, and a later caughtUp does not publish again', async () => {
    expect(await holders.hold(root)).toEqual({ kind: 'held', root });
    await expect(holders.caughtUp(root)).resolves.toBeUndefined();
    expect(writerLock.readWriterLock(root)?.ready).toBe(true);
    expect(vi.mocked(writerLock.markWriterReady)).toHaveBeenCalledTimes(1);

    await expect(holders.caughtUp(root)).resolves.toBeUndefined();
    expect(vi.mocked(writerLock.markWriterReady)).toHaveBeenCalledTimes(1);
  });

  it('a catch-up that waited out lock contention, then failed to publish, raises no unhandled rejection and logs the failure', async () => {
    // The first sync finds codegraph.lock held by a live process (this worker's parent), so it reports lock
    // contention and the catch-up retries after its 1 s backoff. The test removes the lock before that retry;
    // the retry's publish then throws. The only wait is that backoff, so the test stays under 5 s.
    const lockPath = path.join(root, '.codegraph', 'codegraph.lock');
    fs.writeFileSync(lockPath, String(process.ppid));
    writer.failWith = new Error(publishFailure);
    expect(await holders.hold(root)).toEqual({ kind: 'held', root });
    await expect(holders.caughtUp(root)).resolves.toBeUndefined();
    fs.rmSync(lockPath);

    await waitUntil(() => vi.mocked(writerLock.markWriterReady).mock.calls.length > 0, 4_000);
    await expect(holders.caughtUp(root)).resolves.toBeUndefined();
    expect(logLines.some((line) => line.includes(publishFailure))).toBe(true);
  });
});
