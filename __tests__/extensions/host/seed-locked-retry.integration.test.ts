import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { isInitialized } from '../../../src/directory';
import * as coldBuild from '../../../src/extensions/host/worktree-lifecycle/cold-build';
import { COLD_BUILD_EXIT_FAILED, COLD_BUILD_EXIT_LOCKED } from '../../../src/extensions/host/worktree-lifecycle/cold-build';
import { RebuildFences } from '../../../src/extensions/host/builder/fences';
import { BuilderSeedHost } from '../../../src/extensions/host/builder/seed-host';
import { JobQueue } from '../../../src/extensions/host/builder/queue';
import { coldBuildBody } from '../../../src/extensions/host/builder/cold-build-body';
import type { JobSpec } from '../../../src/extensions/host/builder/job-spec-type';

const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

// Each attempt's body runs in this test's module graph, so the CodeGraph spies below reach it.
const runJob = async (_id: number, spec: JobSpec) =>
  coldBuildBody({ root: spec.root }, { progress: () => {}, reportDatabase: () => {}, writerPid: process.pid });

describe('cold build database lock retry', { timeout: 30_000 }, () => {
  let workspace: string;
  let root: string;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-locked-retry-')));
    root = path.join(workspace, 'repo');
    vi.stubEnv('HOME', path.join(workspace, 'home'));
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    fs.mkdirSync(root);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(root, 'app.ts'), 'export function retrySymbol() { return 42; }\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function dbFile(): string {
    return path.join(root, '.codegraph', 'codegraph.db');
  }

  function lockFile(): string {
    return path.join(root, '.codegraph', 'rebuild.pid');
  }

  function leaveDbAndThrow(): void {
    fs.mkdirSync(path.dirname(dbFile()), { recursive: true });
    fs.writeFileSync(dbFile(), 'another initializer');
    throw new Error('database is locked');
  }

  async function settle(queue: JobQueue): Promise<void> {
    await queue.whenRootIdle(root);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  function expectIndexedSymbol(): void {
    expect(isInitialized(root)).toBe(true);
    const db = new DatabaseSync(dbFile(), { readOnly: true });
    try {
      expect(db.prepare('SELECT name FROM nodes WHERE name = ?').get('retrySymbol')).toBeDefined();
    } finally {
      db.close();
    }
  }

  // slow: real git and SQLite setup can be delayed by machine load.
  it('returns LOCKED and removes its database and fence when indexAll throws a lock', async () => {
    vi.spyOn(CodeGraph.prototype, 'indexAll').mockRejectedValue(new Error('SQLite: database is locked'));
    const code = await coldBuild.runColdBuild(root);
    expect.soft(fs.existsSync(dbFile())).toBe(false);
    expect.soft(fs.existsSync(lockFile())).toBe(false);
    expect(code).toBe(4);
    expect(COLD_BUILD_EXIT_LOCKED).toBe(4);
  });

  it('returns LOCKED when indexAll throws a wrapped lock cause', async () => {
    vi.spyOn(CodeGraph.prototype, 'indexAll').mockRejectedValue(
      new Error('indexing failed', { cause: new Error('database is locked') }),
    );
    expect(await coldBuild.runColdBuild(root)).toBe(COLD_BUILD_EXIT_LOCKED);
    expect(fs.existsSync(dbFile())).toBe(false);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('returns LOCKED when indexAll throws an extended SQLITE_BUSY code', async () => {
    vi.spyOn(CodeGraph.prototype, 'indexAll').mockRejectedValue(
      Object.assign(new Error('indexing failed'), { errcode: 5 | (2 << 8) }),
    );
    expect(await coldBuild.runColdBuild(root)).toBe(COLD_BUILD_EXIT_LOCKED);
    expect(fs.existsSync(dbFile())).toBe(false);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('returns FAILED when indexAll throws SQLITE_CONSTRAINT', async () => {
    vi.spyOn(CodeGraph.prototype, 'indexAll').mockRejectedValue(
      Object.assign(new Error('indexing failed'), { errcode: 19 }),
    );
    expect(await coldBuild.runColdBuild(root)).toBe(COLD_BUILD_EXIT_FAILED);
    expect(fs.existsSync(dbFile())).toBe(false);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  // slow: real git and SQLite setup can be delayed by machine load.
  it('returns LOCKED and removes its database when indexAll reports a lock', async () => {
    vi.spyOn(CodeGraph.prototype, 'indexAll').mockResolvedValue({
      success: false, errors: [{ message: 'SQLite: database is locked', severity: 'error' }],
    } as Awaited<ReturnType<CodeGraph['indexAll']>>);
    const code = await coldBuild.runColdBuild(root);
    expect.soft(fs.existsSync(dbFile())).toBe(false);
    expect(code).toBe(4);
  });

  // slow: real git setup can be delayed by machine load.
  it('returns LOCKED when init throws a lock without leaving a database', async () => {
    vi.spyOn(CodeGraph, 'init').mockRejectedValue(new Error('SQLite: database is locked'));
    const code = await coldBuild.runColdBuild(root);
    expect.soft(fs.existsSync(dbFile())).toBe(false);
    expect(code).toBe(4);
  });

  // slow: real git setup can be delayed by machine load.
  it('returns FAILED and preserves a database left by a locked init', async () => {
    vi.spyOn(CodeGraph, 'init').mockImplementation(async () => leaveDbAndThrow());
    expect(await coldBuild.runColdBuild(root)).toBe(1);
    expect(fs.readFileSync(dbFile(), 'utf8')).toBe('another initializer');
  });

  // slow: real git and SQLite setup can be delayed by machine load.
  it('returns FAILED when indexAll throws a non-lock error', async () => {
    vi.spyOn(CodeGraph.prototype, 'indexAll').mockRejectedValue(new Error('disk I/O error'));
    expect(await coldBuild.runColdBuild(root)).toBe(1);
  });

  // slow: real git and SQLite setup can be delayed by machine load.
  it('returns FAILED when indexAll reports failure without an errors field', async () => {
    vi.spyOn(CodeGraph.prototype, 'indexAll').mockResolvedValue({ success: false } as Awaited<ReturnType<CodeGraph['indexAll']>>);
    expect(await coldBuild.runColdBuild(root)).toBe(1);
  });

  // slow: real git and two SQLite indexing attempts can be delayed by machine load.
  it('retries a transient indexAll lock and indexes the root', async () => {
    const index = vi.spyOn(CodeGraph.prototype, 'indexAll').mockRejectedValueOnce(new Error('database is locked'));
    const queue = new JobQueue();
    const host = new BuilderSeedHost(queue, { runJob, seedWaitMs: 0, coldBuildRetry: { attempts: 3, delayMs: 10 } });
    host.queueColdBuild(root, { realRoot: root });
    await settle(queue);
    expect(host.hasFailedBuild(root)).toBe(false);
    expect(index).toHaveBeenCalledTimes(2);
    expectIndexedSymbol();
  });

  it('keeps the root building during the retry delay', async () => {
    const index = vi.spyOn(CodeGraph.prototype, 'indexAll').mockRejectedValueOnce(new Error('database is locked'));
    const queue = new JobQueue();
    const host = new BuilderSeedHost(queue, { runJob, seedWaitMs: 0, coldBuildRetry: { attempts: 2, delayMs: 300 } });
    host.queueColdBuild(root, { realRoot: root });
    try {
      await vi.waitUntil(() => index.mock.calls.length === 1 && !fs.existsSync(lockFile()), { timeout: 2_000, interval: 5 });
      expect(host.buildingRootFor(root)).toBe(root);
      expect(host.hasFailedBuild(root)).toBe(false);
      expect(fs.existsSync(dbFile())).toBe(false);
    } finally {
      await settle(queue);
    }
    expect(index).toHaveBeenCalledTimes(2);
    expect(host.buildingRootFor(root)).toBeNull();
    expect(host.hasFailedBuild(root)).toBe(false);
    expectIndexedSymbol();
  });

  it('does not retry when admission refuses during the retry delay', async () => {
    const index = vi.spyOn(CodeGraph.prototype, 'indexAll').mockRejectedValueOnce(new Error('database is locked'));
    const queue = new JobQueue();
    const host = new BuilderSeedHost(queue, { runJob, seedWaitMs: 0, coldBuildRetry: { attempts: 2, delayMs: 300 } });
    host.queueColdBuild(root, { realRoot: root });
    try {
      await vi.waitUntil(() => index.mock.calls.length === 1 && !fs.existsSync(lockFile()), { timeout: 2_000, interval: 5 });
      fs.renameSync(root, path.join(workspace, 'removed-repo'));
    } finally {
      await settle(queue);
    }
    expect(index).toHaveBeenCalledTimes(1);
    expect(host.hasFailedBuild(root)).toBe(false);
    expect(host.buildingRootFor(root)).toBeNull();
    expect(fs.existsSync(root)).toBe(false);
  });

  it('does not retry when a fence appears during the retry delay', async () => {
    const index = vi.spyOn(CodeGraph.prototype, 'indexAll').mockRejectedValueOnce(new Error('database is locked'));
    const queue = new JobQueue();
    const fences = new RebuildFences(queue, () => {});
    const isFenced = vi.spyOn(fences, 'isFenced').mockReturnValue(false);
    const host = new BuilderSeedHost(queue, { runJob, fences, seedWaitMs: 0, coldBuildRetry: { attempts: 2, delayMs: 300 } });
    host.queueColdBuild(root, { realRoot: root });
    try {
      await vi.waitUntil(() => index.mock.calls.length === 1 && !fs.existsSync(lockFile()), { timeout: 2_000, interval: 5 });
      isFenced.mockReturnValue(true);
    } finally {
      await settle(queue);
    }
    expect(isFenced).toHaveBeenCalledTimes(2);
    expect(index).toHaveBeenCalledTimes(1);
    expect(host.hasFailedBuild(root)).toBe(false);
    expect(host.buildingRootFor(root)).toBeNull();
    expect(fs.existsSync(dbFile())).toBe(false);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  // slow: real git and SQLite setup can be delayed by machine load.
  it('marks a non-lock indexing error failed without retrying', async () => {
    const index = vi.spyOn(CodeGraph.prototype, 'indexAll').mockRejectedValue(new Error('disk I/O error'));
    const queue = new JobQueue();
    const host = new BuilderSeedHost(queue, { runJob, seedWaitMs: 0, coldBuildRetry: { attempts: 3, delayMs: 10 } });
    host.queueColdBuild(root, { realRoot: root });
    await settle(queue);
    expect(host.hasFailedBuild(root)).toBe(true);
    expect(index).toHaveBeenCalledTimes(1);
  });

  // slow: real git and repeated SQLite indexing attempts can be delayed by machine load.
  it('leaves an exhausted lock retry eligible for a later successful build', async () => {
    const index = vi.spyOn(CodeGraph.prototype, 'indexAll').mockRejectedValue(new Error('database is locked'));
    const queue = new JobQueue();
    const host = new BuilderSeedHost(queue, { runJob, seedWaitMs: 0, coldBuildRetry: { attempts: 2, delayMs: 10 } });
    const approval = { realRoot: root };
    host.queueColdBuild(root, approval);
    await settle(queue);
    expect.soft(host.hasFailedBuild(root)).toBe(false);
    expect.soft(index).toHaveBeenCalledTimes(2);
    index.mockRestore();
    host.queueColdBuild(root, approval);
    await settle(queue);
    expect.soft(host.hasFailedBuild(root)).toBe(false);
    expectIndexedSymbol();
  });

  // slow: real git setup can be delayed by machine load.
  it('marks locked init with a database left behind as failed', async () => {
    vi.spyOn(CodeGraph, 'init').mockImplementation(async () => leaveDbAndThrow());
    const queue = new JobQueue();
    const host = new BuilderSeedHost(queue, { runJob, seedWaitMs: 0, coldBuildRetry: { attempts: 2, delayMs: 10 } });
    host.queueColdBuild(root, { realRoot: root });
    await settle(queue);
    expect(host.hasFailedBuild(root)).toBe(true);
    expect(fs.readFileSync(dbFile(), 'utf8')).toBe('another initializer');
  });
});
