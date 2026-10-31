/**
 * Race and robustness gates of the worktree lifecycle. Each case drives the
 * shipped entry point and asserts what is left on disk, in the registry, or
 * still pending, not names or return values.
 *
 * - Seed (`ensureWorktreeIndex` through the engine's tool handler and the
 *   index builder): a seed that fails while a sibling qualifies (the target's
 *   `codegraph.lock` held past the retries) never queues a cold build, though
 *   cold builds need no opt-in: the call answers the success-shaped
 *   not-indexed guidance, and the next call tries the seed again.
 * - Teardown (`sweepWorktrees`): a root re-registered (new nonce, pinned)
 *   while the sweep awaited its release keeps that record and its index.
 * - Query pool (`QueryPool.releaseProject`): a release pending when the pool
 *   is destroyed, one asked for after destroy() starts, and one pending when a
 *   worker errors, all wait until the workers' terminate() has settled.
 * - Teardown: git's answer must be positive before an index is deleted. A
 *   live seeded worktree survives a sweep run with GIT_DIR=/nonexistent in the
 *   environment, and one where every git call fails.
 * - Seed (`seedFromSibling`): a seed that fails after another process put
 *   files in the target's `.codegraph/` removes only what the seed made.
 * - Registry: pin, unpin and seed registration from concurrent processes on
 *   one root never lose a bit or a nonce.
 * - Registry and teardown (darwin, case-insensitive volume): a root pinned
 *   through a wrong-case spelling is not judged gone while git lists it.
 * - Teardown: a registered root is gone only on positive evidence, judged
 *   again under its record lock after the release. A seeded worktree moved
 *   away and restored while its release is awaited keeps its index and its
 *   record; a nested worktree (inside the main checkout) whose `.git` link was
 *   removed and pruned is reclaimed, though git run inside it answers for the
 *   checkout above; a live worktree keeps its index when the main checkout is
 *   moved and `git worktree repair`ed (its record takes the new common dir),
 *   and when the main checkout's directory changes case (case-insensitive
 *   volume); a pinned directory inside a live checkout (not a worktree's
 *   toplevel) stays registered; and git config injected through the environment
 *   (GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n) changes nothing.
 * - Seed and teardown (POSIX): no git call of a seed or a sweep receives the
 *   per-invocation config injection (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT,
 *   GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n, GIT_CONFIG); the user's own
 *   GIT_CONFIG_GLOBAL reaches every one.
 * - Seed (`ensureWorktreeIndex`, POSIX): an index whose `index_state` cannot
 *   be read (its database unreadable) beside a dead `rebuild.pid` is not
 *   discarded as abandoned, though a sibling could seed over it.
 *
 * Real git repositories, real SQLite and real child processes in mkdtemp dirs.
 * The query-pool cases use fake pool workers, so each worker's termination is
 * in the test's hands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { FileLock } from '../../../src/utils';
import { MCPEngine } from '../../../src/mcp/engine';
import { QueryPool, type PoolWorker } from '../../../src/mcp/query-pool';
import { __setLoadCodeGraphForTests } from '../../../src/mcp/tools';
import { ADMIT_ALL } from '../../helpers/admit-all';
import {
  PROJECT_FLAG_PINNED,
  getRegisteredProject,
  listRegisteredProjects,
  pinProject,
  readSeedNonce,
  registerProject,
  unregisterProject,
} from '../../../src/extensions/host/worktree-lifecycle/project-registry';
import { ensureWorktreeIndex, seedFromSibling } from '../../../src/extensions/host/worktree-lifecycle/seed';
import { BuilderClient } from '../../../src/extensions/host/builder/client';
import { BuilderSeedHost } from '../../../src/extensions/host/builder/seed-host';
import { JobQueue } from '../../../src/extensions/host/builder/queue';
import { sweepWorktrees } from '../../../src/extensions/host/worktree-lifecycle/teardown';
import { runProjectPin } from '../../../src/extensions/host/worktree-lifecycle/cli';

const DIST = path.resolve(__dirname, '../../../dist');

// vite's resolver strips the `node:` prefix from an import of node:sqlite,
// so it is loaded with require (as the upstream suites do).
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

/**
 * A pid no process has: above macOS's pid range (max 99998). Linux allows pids
 * up to 4194304, so the case that relies on it asserts it is dead first.
 */
const DEAD_PID = 999999;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function real(p: string): string {
  return fs.realpathSync(path.resolve(p));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The builder's seed host over a fresh queue: seeds and cold builds run as queued jobs, as in the builder process. */
function seedHost(): BuilderSeedHost {
  return new BuilderSeedHost(new JobQueue());
}

/** A one-commit repository holding `app.ts`. */
function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export function appSymbol() { return 42; }\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

async function indexDir(dir: string): Promise<void> {
  const cg = await CodeGraph.init(dir);
  try { await cg.indexAll(); } finally { cg.close(); }
}

function dbFile(root: string): string {
  return path.join(root, '.codegraph', 'codegraph.db');
}

function clearRegistry(): void {
  for (const p of listRegisteredProjects()) unregisterProject(p.root);
}

/** A process that stays alive until killed: a live pid that is not this process. */
function spawnHolder(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true });
}

/** A repository `main` with an index, and a fresh worktree `wt` of it with none. */
async function repoWithWorktree(workspace: string): Promise<{ main: string; wt: string }> {
  const main = path.join(workspace, 'main');
  makeRepo(main);
  await indexDir(main);
  const wt = path.join(workspace, 'feature');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  return { main, wt };
}

// ---------------------------------------------------------------------------
// Seed: a failed seed with a qualifying sibling never cold-builds
// ---------------------------------------------------------------------------

// Builds an index and serves two calls through a real engine and a real index
// builder process; the bound only catches a hang on a loaded machine.
describe('a seed that fails while a sibling qualifies never queues a cold build', { timeout: 60_000 }, () => {
  let workspace: string;
  let wt: string;
  let stateDir: string;
  let engine: MCPEngine | undefined;
  let builder: BuilderClient | undefined;

  beforeEach(async () => {
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '');
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    vi.stubEnv('CODEGRAPH_WATCH_DEBOUNCE_MS', '100');
    vi.stubEnv('CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS', '0');
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-race-f1-')));
    // The builder's own state dir, so its job log (builder.log) is this case's alone.
    stateDir = path.join(workspace, 'state');
    vi.stubEnv('CODEGRAPH_STATE_DIR', stateDir);
    ({ wt } = await repoWithWorktree(workspace));
    // The target's codegraph.lock, held by a live process (this one) for the
    // whole first call: every attempt of the seed to install fails.
    fs.mkdirSync(path.join(wt, '.codegraph'));
    fs.writeFileSync(path.join(wt, '.codegraph', 'codegraph.lock'), String(process.pid));
    __setLoadCodeGraphForTests(CodeGraph);
    builder = BuilderClient.start();
    engine = new MCPEngine({ builder });
  }, 60_000);

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
    await builder?.stop();
    builder = undefined;
    __setLoadCodeGraphForTests(null);
    vi.unstubAllEnvs();
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 60_000);

  async function search(): Promise<{ text: string; isError: boolean }> {
    const res = await engine!.getToolHandler().execute('codegraph_search', { query: 'appSymbol', projectPath: wt }, undefined, ADMIT_ALL);
    return { text: res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'), isError: Boolean(res.isError) };
  }

  it('answers the not-indexed guidance, starts no build, and seeds on the next call', async () => {
    const first = await search();
    expect(first.isError).toBe(false);
    expect(first.text).not.toContain('is building the index');
    expect(first.text).toContain("isn't indexed with codegraph yet");
    // A cold build takes rebuild.pid first thing; none may appear, and the
    // builder's job log shows the seed attempt and no cold-build job.
    await sleep(1000);
    const jobLog = fs.readFileSync(path.join(stateDir, 'builder.log'), 'utf8');
    expect(jobLog).toMatch(/job end seed \S+ failed/);
    expect(jobLog).not.toContain('cold-build');
    expect(fs.existsSync(path.join(wt, '.codegraph', 'rebuild.pid'))).toBe(false);
    expect(fs.existsSync(dbFile(wt))).toBe(false);
    // The holder's lock is untouched.
    expect(fs.readFileSync(path.join(wt, '.codegraph', 'codegraph.lock'), 'utf8')).toBe(String(process.pid));

    // The holder lets go: the next call copies the sibling's index in.
    fs.unlinkSync(path.join(wt, '.codegraph', 'codegraph.lock'));
    const second = await search();
    expect(second.isError).toBe(false);
    expect(second.text).toContain('appSymbol');
    expect(getRegisteredProject(wt)?.seedNonce).toBe(readSeedNonce(wt));
  });
});

// ---------------------------------------------------------------------------
// Teardown: a sweep never drops a record re-registered during its release
// ---------------------------------------------------------------------------

// Builds a real index and runs real git in a temp repository; the bound only
// catches a hang on a loaded machine.
describe('the sweep keeps a root re-registered while it awaited the release', { timeout: 60_000 }, () => {
  let workspace: string;
  let wt: string;

  beforeEach(async () => {
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-race-f2-')));
    let main: string;
    ({ main, wt } = await repoWithWorktree(workspace));
    expect((await ensureWorktreeIndex(wt, seedHost())).kind).toBe('seeded');
    // The worktree leaves its repository while its directory stays: a sweep
    // would delete its seeded index and unregister it.
    fs.rmSync(path.join(wt, '.git'), { force: true });
    git(main, 'worktree', 'prune');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('the new record, its pin and the index survive', async () => {
    const before = getRegisteredProject(wt)!;
    expect(before.seedNonce).toBe(readSeedNonce(wt));
    const newNonce = 'f'.repeat(32);
    const torn = await sweepWorktrees({
      release: async (root) => {
        await sleep(0);
        // Another process registers the root again meanwhile, and pins it.
        registerProject(root, { seeded: true, seedNonce: newNonce });
        pinProject(root);
      },
    });
    expect(torn).toEqual([]);
    const after = getRegisteredProject(wt);
    expect(after?.seedNonce).toBe(newNonce);
    expect((after!.flags & PROJECT_FLAG_PINNED) !== 0).toBe(true);
    expect(fs.existsSync(dbFile(wt))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Query pool: a release waits for worker termination
// ---------------------------------------------------------------------------

/**
 * Fake pool worker: ready at once, never acks a `release` (a worker busy in a
 * long call), and its terminate() settles only when the test calls `stop()`.
 * `emitError()` fires an 'error' at the pool, as a worker dying on its own.
 */
class TerminationFake implements PoolWorker {
  readonly posted: { type?: string }[] = [];
  terminateCalls = 0;
  private msgCb?: (m: unknown) => void;
  private errorCb?: (e: Error) => void;
  private endTermination!: () => void;
  private readonly termination = new Promise<number>((r) => { this.endTermination = () => r(1); });
  constructor() {
    setTimeout(() => this.msgCb?.({ type: 'ready', ok: true }), 0);
  }
  on(event: string, cb: (...args: any[]) => void): void {
    if (event === 'message') this.msgCb = cb;
    else if (event === 'error') this.errorCb = cb;
  }
  postMessage(msg: unknown): void { this.posted.push(msg as { type?: string }); }
  terminate(): Promise<number> {
    this.terminateCalls++;
    return this.termination;
  }
  stop(): void { this.endTermination(); }
  emitError(): void { this.errorCb?.(new Error('fake worker error')); }
  get sawRelease(): boolean { return this.posted.some((m) => m.type === 'release'); }
}

describe('QueryPool.releaseProject resolves only once the workers have stopped', () => {
  let pool: QueryPool | null = null;
  let fakes: TerminationFake[] = [];

  afterEach(async () => {
    for (const f of fakes) f.stop();
    await pool?.destroy();
    pool = null;
    fakes = [];
  });

  function makePool(): QueryPool {
    return new QueryPool({
      root: null, size: 1, idleTimeoutMs: 0, startSettleMs: 30_000,
      createWorker: () => { const f = new TerminationFake(); fakes.push(f); return f; },
    });
  }

  it('a release pending at destroy(), and one asked for after it starts, wait for terminate() to settle', async () => {
    pool = makePool();
    await vi.waitFor(() => expect(pool!.ready).toBe(true));
    const worker = fakes[0]!;
    let released = false;
    const release = pool.releaseProject('/some/root').then(() => { released = true; });
    await vi.waitFor(() => expect(worker.sawRelease).toBe(true));

    let destroyed = false;
    const destroy = pool.destroy().then(() => { destroyed = true; });
    let late = false;
    const lateRelease = pool.releaseProject('/some/root').then(() => { late = true; });
    await sleep(50);
    expect(worker.terminateCalls).toBe(1);
    expect(released).toBe(false);
    expect(late).toBe(false);
    expect(destroyed).toBe(false);

    worker.stop();
    await Promise.all([release, lateRelease, destroy]);
    expect(released).toBe(true);
    expect(late).toBe(true);
  });

  it('a release pending when a worker errors waits for that worker\'s terminate() to settle', async () => {
    pool = makePool();
    await vi.waitFor(() => expect(pool!.ready).toBe(true));
    const worker = fakes[0]!;
    let released = false;
    const release = pool.releaseProject('/some/root').then(() => { released = true; });
    await vi.waitFor(() => expect(worker.sawRelease).toBe(true));

    worker.emitError();
    await sleep(50);
    expect(worker.terminateCalls).toBe(1);
    expect(released).toBe(false);

    worker.stop();
    await release;
    expect(released).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Teardown: a git that cannot answer proves nothing
// ---------------------------------------------------------------------------

// Builds a real index and runs real git in a temp repository; the bound only
// catches a hang on a loaded machine.
describe('a sweep keeps a live seeded worktree when git cannot answer', { timeout: 60_000 }, () => {
  let workspace: string;
  let wt: string;

  beforeEach(async () => {
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-race-f4-')));
    ({ wt } = await repoWithWorktree(workspace));
    expect((await ensureWorktreeIndex(wt, seedHost())).kind).toBe('seeded');
    // A valid registration: the record's nonce is the one in the index, so
    // only the gone judgement stands between the index and its deletion.
    const rec = getRegisteredProject(wt);
    expect(rec?.seedNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(readSeedNonce(wt)).toBe(rec!.seedNonce);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function expectKept(torn: string[]): void {
    expect(torn).toEqual([]);
    expect(fs.existsSync(dbFile(wt))).toBe(true);
    expect(getRegisteredProject(wt)?.seedNonce).toBe(readSeedNonce(wt));
  }

  it('with GIT_DIR=/nonexistent in the environment', async () => {
    vi.stubEnv('GIT_DIR', '/nonexistent');
    expectKept(await sweepWorktrees({ release: async () => { /* nothing open here */ } }));
  });

  it.runIf(process.platform !== 'win32')('when every git call fails', async () => {
    const bin = path.join(workspace, 'fake-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho "fatal: unable to access config" >&2\nexit 128\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    expectKept(await sweepWorktrees({ release: async () => { /* nothing open here */ } }));
  });
});

// ---------------------------------------------------------------------------
// Seed: a failed seed removes only what it created
// ---------------------------------------------------------------------------

// Builds a real index and runs real git in a temp repository; the bound only
// catches a hang on a loaded machine.
describe('a failed seed never removes another process\'s files from the target', { timeout: 60_000 }, () => {
  let workspace: string;
  let main: string;
  let wt: string;
  let holder: ChildProcess | undefined;

  beforeEach(async () => {
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-race-f5-')));
    ({ main, wt } = await repoWithWorktree(workspace));
    holder = spawnHolder();
    await vi.waitFor(() => expect(holder!.pid).toBeGreaterThan(0));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { holder?.kill('SIGKILL'); } catch { /* gone */ }
    holder = undefined;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  /** Entries of `dir` a seed by this process staged (its copy and side files). */
  function ownStaging(dir: string): string[] {
    return fs.readdirSync(dir).filter((n) => n.startsWith(`codegraph.db.seed-${process.pid}-`));
  }

  it('another initializer\'s lock and staged copy, planted after the seed made the directory, survive', async () => {
    const dir = path.join(wt, '.codegraph');
    expect(fs.existsSync(dir)).toBe(false);
    const lockPath = path.join(dir, 'codegraph.lock');
    const otherStaging = path.join(dir, `codegraph.db.seed-${holder!.pid}-0badc0de.tmp`);
    // The moment the seed first reaches for the target's lock, another live
    // process takes it and stages its own copy beside it: the seed then fails
    // with the directory it made holding that process's files.
    const acquire = FileLock.prototype.acquire;
    let planted = false;
    vi.spyOn(FileLock.prototype, 'acquire').mockImplementation(function (this: FileLock) {
      if ((this as unknown as { lockPath: string }).lockPath === lockPath && !planted) {
        planted = true;
        fs.writeFileSync(lockPath, String(holder!.pid));
        fs.writeFileSync(otherStaging, 'another seeder\'s copy');
      }
      return acquire.call(this);
    });

    await expect(seedFromSibling(wt, main)).rejects.toThrow();
    expect(planted).toBe(true);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(holder!.pid));
    expect(fs.readFileSync(otherStaging, 'utf8')).toBe('another seeder\'s copy');
    // The seed's own staged copy is gone. Its .gitignore may stay: the lock's
    // holder may be installing an index that relies on it.
    expect(ownStaging(dir)).toEqual([]);
    expect(fs.readdirSync(dir).filter((n) => n !== '.gitignore').sort())
      .toEqual([path.basename(lockPath), path.basename(otherStaging)].sort());
  });

  it('a file another process staged while the target lock was busy survives; the seed\'s own files go', async () => {
    const dir = path.join(wt, '.codegraph');
    const lockPath = path.join(dir, 'codegraph.lock');
    const otherStaging = path.join(dir, `codegraph.db.seed-${holder!.pid}-0badc0de.tmp`);
    // The install's attempts on the target lock all find it busy (another
    // process's moment holding it, gone again before the cleanup's attempt),
    // and that process staged a copy meanwhile.
    const acquire = FileLock.prototype.acquire;
    let attempts = 0;
    vi.spyOn(FileLock.prototype, 'acquire').mockImplementation(function (this: FileLock) {
      if ((this as unknown as { lockPath: string }).lockPath === lockPath && attempts++ < 5) {
        if (attempts === 1) fs.writeFileSync(otherStaging, 'another seeder\'s copy');
        throw new Error('CodeGraph database is locked by another process');
      }
      return acquire.call(this);
    });

    await expect(seedFromSibling(wt, main)).rejects.toThrow(/locked by another process/);
    expect(fs.existsSync(otherStaging)).toBe(true);
    // The cleanup took the lock (the sixth attempt): the seed's .gitignore and
    // staged copy are gone, the other process's copy and the directory
    // holding it stay.
    expect(attempts).toBe(6);
    expect(fs.readdirSync(dir)).toEqual([path.basename(otherStaging)]);
  });

  it('a failed seed with nobody else in the target leaves no .codegraph behind', async () => {
    const dir = path.join(wt, '.codegraph');
    const lockPath = path.join(dir, 'codegraph.lock');
    const acquire = FileLock.prototype.acquire;
    let attempts = 0;
    vi.spyOn(FileLock.prototype, 'acquire').mockImplementation(function (this: FileLock) {
      if ((this as unknown as { lockPath: string }).lockPath === lockPath && attempts++ < 5) {
        throw new Error('CodeGraph database is locked by another process');
      }
      return acquire.call(this);
    });
    await expect(seedFromSibling(wt, main)).rejects.toThrow(/locked by another process/);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registry: concurrent registry updates lose nothing
// ---------------------------------------------------------------------------

/**
 * One registry client in its own process, against the built registry. Waits
 * for `<barrier>/go`, then runs its role `n` times, reading its own write back
 * each time: `seeder` registers seed nonce `nonce-<i>` and expects to read it;
 * `pinner` pins and expects pinned, then unpins and expects unpinned (ending
 * pinned); `other` re-registers the root with a common dir. Prints the number
 * of read-backs that did not hold.
 */
const REGISTRY_CLIENT = `
const fs = require('fs');
const path = require('path');
const [registryModule, root, role, n, barrier] = process.argv.slice(2);
const R = require(registryModule);
fs.writeFileSync(path.join(barrier, 'ready-' + role), '');
const tick = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(path.join(barrier, 'go'))) Atomics.wait(tick, 0, 0, 1);
let violations = 0;
for (let i = 0; i < Number(n); i++) {
  if (role === 'seeder') {
    R.registerProject(root, { seeded: true, seedNonce: 'nonce-' + i });
    if (R.getRegisteredProject(root)?.seedNonce !== 'nonce-' + i) violations++;
  } else if (role === 'pinner') {
    R.pinProject(root);
    if (!R.isPinned(root)) violations++;
    if (i < Number(n) - 1) {
      R.unpinProject(root);
      if (R.isPinned(root)) violations++;
    }
  } else {
    R.registerProject(root, { commonDir: '/some/common/dir' });
  }
}
process.stdout.write(JSON.stringify({ violations }));
`;

// Spawns three node processes against the built registry; the bound only
// catches a hang on a loaded machine.
describe('concurrent pins and seed registrations of one root lose no bit and no nonce', { timeout: 60_000 }, () => {
  let workspace: string;

  beforeEach(() => {
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-race-f6-')));
  });

  afterEach(() => {
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  // Starts three node processes that load the built registry: a second or two
  // under load.
  it('three processes updating one record: every read-back holds, and the record ends pinned with the last nonce', async () => {
    const root = path.join(workspace, 'project');
    fs.mkdirSync(root);
    const script = path.join(workspace, 'registry-client.js');
    fs.writeFileSync(script, REGISTRY_CLIENT);
    const barrier = path.join(workspace, 'barrier');
    fs.mkdirSync(barrier);
    const registryModule = path.join(DIST, 'extensions', 'host', 'worktree-lifecycle', 'project-registry.js');
    // Enough rounds per process that three of them overlap inside the record
    // lock many times; small enough to finish in a second or two.
    const n = 150;
    const roles = ['seeder', 'pinner', 'other'];
    const runs = roles.map((role) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [script, registryModule, root, role, String(n), barrier], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      child.stdout!.on('data', (d) => { out += d; });
      child.stderr!.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ code, out, err }));
    }));
    await vi.waitFor(() => {
      for (const role of roles) expect(fs.existsSync(path.join(barrier, `ready-${role}`))).toBe(true);
    }, { timeout: 30_000 });
    fs.writeFileSync(path.join(barrier, 'go'), '');
    const results = await Promise.all(runs);
    for (const r of results) expect(r.code, r.err).toBe(0);
    const violations = results.reduce((sum, r) => sum + (JSON.parse(r.out) as { violations: number }).violations, 0);
    expect(violations).toBe(0);
    const rec = getRegisteredProject(root);
    expect((rec!.flags & PROJECT_FLAG_PINNED) !== 0).toBe(true);
    expect(rec!.seedNonce).toBe(`nonce-${n - 1}`);
  });
});

// ---------------------------------------------------------------------------
// Registry and teardown: one canonical spelling for a common dir
// ---------------------------------------------------------------------------

const CASE_INSENSITIVE_TMP = process.platform === 'darwin'
  && fs.existsSync(os.tmpdir().toUpperCase())
  && fs.realpathSync.native(os.tmpdir().toUpperCase()) !== os.tmpdir().toUpperCase();

// Makes a real repository and runs real git in it; the bound only catches a
// hang on a loaded machine.
describe('a root pinned through a wrong-case spelling stays registered while git lists it', { timeout: 60_000 }, () => {
  let workspace: string;

  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-race-f7-')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it.runIf(CASE_INSENSITIVE_TMP)('the sweep does not judge it gone', async () => {
    const repo = path.join(workspace, 'CaseRepo');
    makeRepo(repo);
    const wrongCase = path.join(workspace, 'caserepo');
    expect(fs.existsSync(wrongCase)).toBe(true);
    vi.spyOn(console, 'log').mockImplementation(() => { /* the CLI's success line */ });
    await runProjectPin(wrongCase);
    const rec = getRegisteredProject(repo);
    expect(rec?.root).toBe(fs.realpathSync.native(repo));
    expect((rec!.flags & PROJECT_FLAG_PINNED) !== 0).toBe(true);

    const torn = await sweepWorktrees({ release: async () => { /* nothing open here */ } });
    expect(torn).toEqual([]);
    expect(getRegisteredProject(repo)).toEqual(rec);
  });
});

// ---------------------------------------------------------------------------
// Teardown: a registered root is gone only on positive evidence
// ---------------------------------------------------------------------------

/**
 * A repository `main` with an index, and a worktree of it seeded from main
 * through the shipped entry point (registered SEEDED with main's common dir
 * and the nonce its index carries). `nested` puts the worktree inside the
 * main checkout, at `main/.worktrees/nested`.
 */
async function seededWorktree(workspace: string, nested = false): Promise<{ main: string; wt: string }> {
  const main = path.join(workspace, 'main');
  makeRepo(main);
  await indexDir(main);
  const wt = nested ? path.join(main, '.worktrees', 'nested') : path.join(workspace, 'feature');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  expect((await ensureWorktreeIndex(wt, seedHost())).kind).toBe('seeded');
  const rec = getRegisteredProject(wt);
  expect(rec?.seedNonce).toMatch(/^[0-9a-f]{32}$/);
  expect(readSeedNonce(wt)).toBe(rec!.seedNonce);
  return { main, wt };
}

// Each case indexes one file, seeds one worktree and runs real git; the bound
// only catches a hang on a loaded machine.
describe('a registered root is gone only on positive evidence', { timeout: 60_000 }, () => {
  let workspace: string;

  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '');
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-race-gone-')));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('a worktree moved away and restored while its release is awaited keeps its index and its record', async () => {
    const { wt } = await seededWorktree(workspace);
    const before = getRegisteredProject(wt)!;
    const away = path.join(workspace, 'away');
    fs.renameSync(wt, away);
    let released = false;
    const torn = await sweepWorktrees({
      release: async (root) => {
        released = true;
        // The worktree comes back before teardown acts on the verdict it had.
        fs.renameSync(away, root);
        expect(real(git(root, 'rev-parse', '--show-toplevel'))).toBe(root);
      },
    });
    // The sweep did judge it gone (its directory was missing) and released it.
    expect(released).toBe(true);
    expect(torn).toEqual([]);
    expect(fs.existsSync(dbFile(wt))).toBe(true);
    expect(readSeedNonce(wt)).toBe(before.seedNonce);
    expect(getRegisteredProject(wt)).toEqual(before);
  });

  it('a nested worktree whose .git link was removed and pruned is reclaimed, though git inside it finds the checkout above', async () => {
    const { main, wt } = await seededWorktree(workspace, true);
    fs.unlinkSync(path.join(wt, '.git'));
    git(main, 'worktree', 'prune');
    // Git run from inside the directory answers for the checkout above it.
    expect(real(git(wt, 'rev-parse', '--show-toplevel'))).toBe(main);
    const torn = await sweepWorktrees({ release: async () => { /* nothing open here */ } });
    expect(torn).toEqual([wt]);
    expect(fs.existsSync(path.join(wt, '.codegraph'))).toBe(false);
    // Only the seeded index goes: the files, and the checkout above's index, stay.
    expect(fs.existsSync(path.join(wt, 'app.ts'))).toBe(true);
    expect(fs.existsSync(dbFile(main))).toBe(true);
    expect(getRegisteredProject(wt)).toBeNull();
  });

  it('a live worktree keeps its index when the main checkout is moved and repaired, and its record takes the new common dir', async () => {
    const { main, wt } = await seededWorktree(workspace);
    const before = getRegisteredProject(wt)!;
    expect(before.commonDir).toBe(real(path.join(main, '.git')));
    const moved = path.join(workspace, 'moved-main');
    fs.renameSync(main, moved);
    git(moved, 'worktree', 'repair', wt);
    expect(real(git(wt, 'rev-parse', '--show-toplevel'))).toBe(wt);
    expect(git(moved, 'worktree', 'list', '--porcelain')).toContain(wt);
    const torn = await sweepWorktrees({ release: async () => { /* nothing open here */ } });
    expect(torn).toEqual([]);
    expect(fs.existsSync(dbFile(wt))).toBe(true);
    expect(readSeedNonce(wt)).toBe(before.seedNonce);
    expect(getRegisteredProject(wt)).toEqual({ ...before, commonDir: real(path.join(moved, '.git')) });
  });

  it.runIf(CASE_INSENSITIVE_TMP)('a live worktree keeps its index when the main checkout\'s directory changes case', async () => {
    const { main, wt } = await seededWorktree(workspace);
    const before = getRegisteredProject(wt)!;
    fs.renameSync(main, path.join(workspace, 'MAIN'));
    expect(real(git(wt, 'rev-parse', '--show-toplevel'))).toBe(wt);
    const torn = await sweepWorktrees({ release: async () => { /* nothing open here */ } });
    expect(torn).toEqual([]);
    expect(fs.existsSync(dbFile(wt))).toBe(true);
    expect(getRegisteredProject(wt)).toEqual(before);
  });

  // A pin may name a directory inside a worktree (a subproject with its own
  // index); only a seeded root is always a worktree's toplevel.
  it('a pinned directory inside a live checkout stays registered', async () => {
    const main = path.join(workspace, 'main');
    makeRepo(main);
    const sub = path.join(main, 'packages', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    registerProject(sub, { commonDir: real(path.join(main, '.git')) });
    const rec = pinProject(sub);
    const torn = await sweepWorktrees({ release: async () => { /* nothing open here */ } });
    expect(torn).toEqual([]);
    expect(getRegisteredProject(sub)).toEqual(rec);
  });

  it('a live seeded worktree survives a sweep run with git config injected through the environment', async () => {
    const { wt } = await seededWorktree(workspace);
    const before = getRegisteredProject(wt)!;
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.worktree');
    vi.stubEnv('GIT_CONFIG_VALUE_0', '/elsewhere');
    const torn = await sweepWorktrees({ release: async () => { /* nothing open here */ } });
    expect(torn).toEqual([]);
    expect(fs.existsSync(dbFile(wt))).toBe(true);
    expect(getRegisteredProject(wt)).toEqual(before);
  });

  // git reads core.worktree only from the repository's own config file, so the
  // case above holds even when the injection reaches git. This one watches
  // the environment each git call of a seed and a sweep actually gets.
  it.runIf(process.platform !== 'win32')('no git call of a seed or a sweep gets config injected through the environment; the user\'s config files stay', async () => {
    const { wt } = await repoWithWorktree(workspace);
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
    expect(realGit).not.toBe('');
    // A git that logs the names of the GIT_CONFIG* variables it was given,
    // one block per call, then runs the real git.
    const bin = path.join(workspace, 'logging-bin');
    fs.mkdirSync(bin);
    const log = path.join(workspace, 'git-env.log');
    fs.writeFileSync(
      path.join(bin, 'git'),
      `#!/bin/sh\nenv | grep '^GIT_CONFIG' | sed 's/=.*//' >> "${log}"\necho --- >> "${log}"\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('GIT_CONFIG_PARAMETERS', "'core.worktree'='/elsewhere'");
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.worktree');
    vi.stubEnv('GIT_CONFIG_VALUE_0', '/elsewhere');
    vi.stubEnv('GIT_CONFIG', path.join(workspace, 'elsewhere-config'));
    const userGlobal = process.env.GIT_CONFIG_GLOBAL;

    expect((await ensureWorktreeIndex(wt, seedHost())).kind).toBe('seeded');
    expect(await sweepWorktrees({ release: async () => { /* nothing open here */ } })).toEqual([]);

    const calls = fs.readFileSync(log, 'utf8').split('---\n').slice(0, -1).map((block) => block.split('\n').filter(Boolean));
    // The seed's lookups (toplevel, worktree list, common dir) and the sweep's.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const names of calls) {
      expect(names.filter((n) => n === 'GIT_CONFIG' || n === 'GIT_CONFIG_PARAMETERS' || n === 'GIT_CONFIG_COUNT'
        || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(n))).toEqual([]);
      if (userGlobal !== undefined) expect(names).toContain('GIT_CONFIG_GLOBAL');
    }
    expect(fs.existsSync(dbFile(wt))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Seed: an index whose state cannot be read is never discarded
// ---------------------------------------------------------------------------

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `index_state` of `root`'s index, read directly. */
function indexState(root: string): string | null {
  const db = new DatabaseSync(dbFile(root), { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM project_metadata WHERE key = 'index_state'").get() as { value?: string } | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

/** Permission bits do not stop root, and Windows has no such mode bits. */
const CAN_DENY_READ = process.platform !== 'win32' && process.getuid?.() !== 0;

// Builds an index and plants a partial one; the bound only catches a hang on a
// loaded machine.
describe('an index whose state cannot be read is never discarded as abandoned', { timeout: 60_000 }, () => {
  let workspace: string;

  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '');
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-race-unreadable-')));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it.runIf(CAN_DENY_READ)('an unreadable database beside a dead rebuild.pid survives a call a sibling could seed', async () => {
    // main has a complete index, so a seed over the worktree's would be allowed.
    const { wt } = await repoWithWorktree(workspace);
    // What a killed cold build leaves: the schema, index_state 'indexing', and
    // a rebuild.pid naming a dead pid. Read, that is an abandoned index.
    CodeGraph.initSync(wt).close();
    const writable = new DatabaseSync(dbFile(wt));
    try {
      writable.prepare("INSERT OR REPLACE INTO project_metadata (key, value, updated_at) VALUES ('index_state', 'indexing', ?)").run(Date.now());
    } finally {
      writable.close();
    }
    expect(pidAlive(DEAD_PID)).toBe(false);
    fs.writeFileSync(
      path.join(wt, '.codegraph', 'rebuild.pid'),
      JSON.stringify({ pid: DEAD_PID, mode: 'cold-build', startedAt: Date.now(), root: wt }) + '\n',
    );
    const db = dbFile(wt);
    const ino = fs.statSync(db).ino;
    // The state cannot be read: no read proves the build unfinished.
    fs.chmodSync(db, 0o000);
    try {
      const outcome = await ensureWorktreeIndex(wt, seedHost());
      expect(outcome.kind).toBe('none');
      expect(fs.statSync(db).ino).toBe(ino);
    } finally {
      fs.chmodSync(db, 0o644);
    }
    expect(indexState(wt)).toBe('indexing');
    expect(getRegisteredProject(wt)).toBeNull();
  });
});
