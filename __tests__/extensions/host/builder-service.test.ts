/**
 * The index builder's service (src/extensions/host/builder/service.ts, holder.ts) run in this process with a
 * recording `send`, so the cases can read what it pushes and hold its queue still. The forked process and the
 * client are covered in builder-client.test.ts; here the logic is under test: holds, the watcher's pending set
 * as pushed freshness, a root another process writes, a rebuild in progress, and the housekeeping release.
 *
 * Real SQLite and real files in mkdtemp dirs; the watcher is the real FileWatcher on a short debounce.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import CodeGraph from '../../../src/index';
import { unsafeIndexRootReason } from '../../../src/directory';
import { validateProjectPath } from '../../../src/utils';
import { readWriterLock } from '../../../src/mcp/writer-lock';
import { BuilderService } from '../../../src/extensions/host/builder/service';
import { JobQueue } from '../../../src/extensions/host/builder/queue';
import { BuilderSeedHost } from '../../../src/extensions/host/builder/seed-host';
import {
  ensureWorktreeIndex,
  isAbandonedIndex,
  unbuiltDirectoryNote,
  unseededWorktreeNote,
  type SeedHost,
} from '../../../src/extensions/host/worktree-lifecycle/seed';
import type { BuilderFreshness } from '../../../src/extensions/host/builder/client';
import type { BuilderToServer } from '../../../src/extensions/host/builder/protocol';

// vite's resolver strips the `node:` prefix from an import of node:sqlite, so the module is required (as in the
// server test and the followups gate).
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

/** A pid no process holds (the followups gate's choice): a rebuild.pid naming it is a killed build's. */
const DEAD_PID = 999999;

function real(p: string): string {
  return fs.realpathSync(path.resolve(p));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntil(check: () => boolean, timeoutMs: number, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return check();
}

async function indexedProject(dir: string): Promise<void> {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'base.ts'), 'export function baseSymbol() { return 1; }\n');
  const cg = await CodeGraph.init(dir);
  try { await cg.indexAll(); } finally { cg.close(); }
}

describe('BuilderService', { timeout: 60_000 }, () => {
  let workspace: string;
  let service: BuilderService | undefined;
  let sent: BuilderToServer[];
  let jobLines: string[];
  let children: ChildProcess[];

  beforeEach(() => {
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-builder-service-')));
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    sent = [];
    jobLines = [];
    children = [];
  });

  afterEach(async () => {
    await service?.stop(0);
    service = undefined;
    for (const child of children) child.kill('SIGKILL');
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 30_000);

  function startService(housekeeping = false, seedWaitMs = 1_000): BuilderService {
    service = new BuilderService({
      send: (message) => { sent.push(message); },
      jobLog: (line) => { jobLines.push(line); },
      log: () => { /* diagnostics are not under test */ },
      watchOptions: () => ({ debounceMs: 100 }),
      timing: { pollMs: 25, ownRetryMs: 50, recoverWaitMs: 1_000, seedWaitMs },
      housekeeping,
    });
    return service;
  }

  const freshnessOf = (root: string): BuilderFreshness[] =>
    sent.filter((m): m is Extract<BuilderToServer, { op: 'freshness' }> => (m as { op?: string }).op === 'freshness')
      .map((m) => m.state)
      .filter((s) => s.root === real(root));

  /** A live process that is not this one, to stand in as another writer of a root. */
  function otherLiveProcess(): ChildProcess {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
    children.push(child);
    return child;
  }

  it('holds an indexed root: ready, the writer slot is its own, and the pending set is pushed until the sync clears it', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    const svc = startService();

    expect(await svc.ensure(root)).toEqual({ kind: 'ready', root: real(root) });
    expect(readWriterLock(root)).toMatchObject({ pid: process.pid, mode: 'builder' });
    await svc.holders.caughtUp(root);
    expect(await waitUntil(() => freshnessOf(root).some((s) => s.watching), 5_000)).toBe(true);

    // Keep the queue busy so the watcher's sync waits: the edit stays pending, and the push says so.
    let release!: () => void;
    const blocker = svc.queue.enqueue('cold-build', '/blocker', () => new Promise<void>((resolve) => { release = resolve; }));
    await waitUntil(() => svc.queue.runningJob()?.root === '/blocker', 2_000);
    fs.writeFileSync(path.join(root, 'src', 'base.ts'), 'export function baseSymbol() { return 1; }\nexport function more() { return 2; }\n');
    expect(await waitUntil(() => freshnessOf(root).some((s) => s.pendingFiles.includes('src/base.ts')), 10_000)).toBe(true);
    expect(svc.freshness(root)?.pendingFiles).toContain('src/base.ts');

    release();
    await blocker;
    // The watch-sync ran: the pending set is empty again, and the log has the job.
    expect(await waitUntil(() => freshnessOf(root).at(-1)?.pendingFiles.length === 0, 10_000)).toBe(true);
    expect(jobLines.some((l) => / job end watch-sync \S+ ok$/.test(l))).toBe(true);
  });

  it('the writable open is a queued job: while a cold build runs, ensure answers after its bounded wait and opens nothing until the build ends', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    const svc = startService(false, 200);

    let finishCold!: () => void;
    const cold = svc.queue.enqueue('cold-build', '/blocker', () => new Promise<void>((resolve) => { finishCold = resolve; }));
    await waitUntil(() => svc.queue.runningJob()?.root === '/blocker', 2_000);

    // The wait runs out (200 ms) with the open still queued: the answer is the same `ready`, the database is
    // not open for writing, writer.pid is not taken, and no open job has started.
    expect(await svc.ensure(root)).toEqual({ kind: 'ready', root: real(root) });
    expect(readWriterLock(root)).toBeNull();
    expect(jobLines.filter((l) => / job start open /.test(l))).toEqual([]);
    expect(svc.queue.waiting().sync).toBe(1);

    // The cold build ends: the open job runs next, takes the slot as the builder and catches up.
    finishCold();
    await cold;
    await svc.holders.caughtUp(root);
    expect(readWriterLock(root)).toMatchObject({ pid: process.pid, mode: 'builder' });
    const edges = jobLines.map((l) => /^\S+ job (start|end) (\S+)/.exec(l)).map((m) => (m ? `${m[1]} ${m[2]}` : ''));
    expect(edges.indexOf('end cold-build')).toBeGreaterThanOrEqual(0);
    expect(edges.indexOf('end cold-build')).toBeLessThan(edges.indexOf('start open'));
    expect(jobLines.some((l) => / job end open \S+ ok$/.test(l))).toBe(true);
  });

  it('a hold released while its open waits behind a cold build opens nothing and does not wait for the build', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    const svc = startService(false, 100);
    let finishCold!: () => void;
    const cold = svc.queue.enqueue('cold-build', '/blocker', () => new Promise<void>((resolve) => { finishCold = resolve; }));
    await waitUntil(() => svc.queue.runningJob()?.root === '/blocker', 2_000);
    await svc.ensure(root);

    // The release answers while the cold build still runs.
    await svc.holders.release(root);
    expect(svc.holders.has(root)).toBe(false);
    finishCold();
    await cold;
    await svc.queue.whenIdle();
    // The queued open found the hold closed: the root was never opened for writing.
    expect(readWriterLock(root)).toBeNull();
    expect(svc.holders.has(root)).toBe(false);
  });

  it('answers the same root again at once, and a reply for a failed request names the error', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    const svc = startService();
    await svc.ensure(root);
    const jobsBefore = jobLines.length;
    expect(await svc.ensure(path.join(root, 'src'))).toEqual({ kind: 'ready', root: real(root) });
    expect(jobLines.length).toBe(jobsBefore);

    await svc.handle({ id: 7, op: 'sync', root: path.join(workspace, 'nowhere') });
    expect(sent.at(-1)).toMatchObject({ id: 7, ok: false, errorName: 'Error' });
    await svc.handle({ id: 8, op: 'sync', root });
    expect(sent.at(-1)).toMatchObject({ id: 8, ok: true, result: { filesChanged: expect.any(Number) } });
  });

  it('a root another live process owns is held without writes, and taken over when that process lets go', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    const other = otherLiveProcess();
    const pidFile = path.join(root, '.codegraph', 'writer.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: other.pid, mode: 'direct', startedAt: Date.now(), ready: true }) + '\n');
    const svc = startService();

    expect(await svc.ensure(root)).toEqual({ kind: 'ready', root: real(root) });
    // Not ours: nothing is opened for writing, a sync has nothing to do, and the owner's record is untouched.
    expect(readWriterLock(root)?.pid).toBe(other.pid);
    await expect(svc.holders.sync(root)).resolves.toEqual({ filesChanged: 0 });
    expect(jobLines.filter((l) => / job start (sync|catch-up|watch-sync) /.test(l))).toEqual([]);

    // The owner goes away: the periodic retry takes the slot and runs the catch-up.
    fs.unlinkSync(pidFile);
    expect(await waitUntil(() => readWriterLock(root)?.pid === process.pid, 10_000)).toBe(true);
    await svc.holders.caughtUp(root);
    expect(jobLines.some((l) => / job end catch-up \S+ ok$/.test(l))).toBe(true);
  });

  it('answers building, and opens nothing, while another process holds rebuild.pid', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    const other = otherLiveProcess();
    fs.writeFileSync(
      path.join(root, '.codegraph', 'rebuild.pid'),
      JSON.stringify({ pid: other.pid, mode: 'rebuild', startedAt: Date.now() }) + '\n',
    );
    const svc = startService();
    expect(await svc.ensure(root)).toEqual({ kind: 'building', root: real(root) });
    expect(svc.holders.has(root)).toBe(false);
    expect(readWriterLock(root)).toBeNull();
  });

  it('release frees the writer slot and the hold; a hold after it works again', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    const svc = startService();
    await svc.ensure(root);
    await svc.holders.release(root);
    expect(readWriterLock(root)).toBeNull();
    expect(svc.holders.has(root)).toBe(false);
    expect(svc.freshness(root)).toBeNull();
    expect(await svc.ensure(root)).toEqual({ kind: 'ready', root: real(root) });
    expect(readWriterLock(root)?.pid).toBe(process.pid);
  });

  it('the housekeeping pass releases a held root whose index vanished, and tells the server', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    const svc = startService(true);
    await svc.ensure(root);
    await svc.holders.caughtUp(root);
    fs.rmSync(path.join(root, '.codegraph', 'codegraph.db'), { force: true });
    await svc.runHousekeepingPass();
    expect(svc.holders.has(root)).toBe(false);
    expect(readWriterLock(root)).toBeNull();
    expect(sent).toContainEqual({ op: 'released', root: real(root) });
  });

  it('a path that does not exist answers none; a stopping service refuses new jobs', async () => {
    const missing = path.join(workspace, 'missing');
    const svc = startService();
    expect(await svc.ensure(missing)).toEqual({ kind: 'none' });
    await svc.stop(0);
    await expect(svc.queue.enqueue('sync', missing, async () => undefined)).rejects.toThrow(/stopping/);
  });

  // The anchor comes over IPC and is data: a root that does not contain the path is not what the call is about.
  // Each anchor here is a real directory that would be built if the check were missing.
  it('refuses an anchor that does not contain the path: nothing is built or created for a stranger, a sibling that shares a name prefix, or a subdirectory of the path', async () => {
    const plain = path.join(workspace, 'plain');
    const sub = path.join(plain, 'sub');
    const stranger = path.join(workspace, 'stranger');
    const prefixSibling = path.join(workspace, 'plain-evil');
    const below = path.join(sub, 'deeper');
    for (const dir of [below, stranger, prefixSibling]) fs.mkdirSync(dir, { recursive: true });
    const svc = startService();

    for (const anchor of [stranger, prefixSibling, below]) {
      expect(await svc.ensure(sub, anchor), `anchor ${anchor}`).toEqual({ kind: 'none' });
    }
    for (const dir of [plain, sub, stranger, prefixSibling, below]) {
      expect(fs.existsSync(path.join(dir, '.codegraph')), `${dir}/.codegraph`).toBe(false);
    }
    expect(jobLines, 'no job was queued').toEqual([]);
  });

  it('never builds an unsafe root: the home directory and the filesystem root answer unbuilt with what they look like', async () => {
    const home = path.join(workspace, 'home');
    const project = path.join(home, 'proj');
    fs.mkdirSync(project, { recursive: true });
    // os.homedir() reads HOME (USERPROFILE on Windows), so the unsafe-root check sees this directory as home.
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const fsRoot = path.parse(real(workspace)).root;
    const svc = startService();

    expect(await svc.ensure(project, home)).toEqual({ kind: 'none', unbuilt: { root: real(home), unsafe: 'your home directory' } });
    expect(await svc.ensure(home)).toEqual({ kind: 'none', unbuilt: { root: real(home), unsafe: 'your home directory' } });
    expect(await svc.ensure(project, fsRoot)).toEqual({ kind: 'none', unbuilt: { root: fsRoot, unsafe: 'the filesystem root' } });
    for (const dir of [home, project, fsRoot]) {
      expect(fs.existsSync(path.join(dir, '.codegraph')), `${dir}/.codegraph`).toBe(false);
    }
    expect(jobLines, 'no job was queued').toEqual([]);
  });

  it('queues the cold build of a plain directory at the anchor root (the path itself without one), and answers unbuilt, not building, once the host reports the build failed', async () => {
    const anchor = path.join(workspace, 'plain');
    const sub = path.join(anchor, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const queued: string[] = [];
    let failed = false;
    const host: SeedHost = {
      buildingRootFor: () => null,
      hasFailedBuild: () => failed,
      queueColdBuild: (root) => { queued.push(root); },
      runSeed: async () => ({ done: false as const }),
    };

    expect(await ensureWorktreeIndex(sub, host, anchor)).toEqual({ kind: 'building', root: real(anchor) });
    expect(await ensureWorktreeIndex(sub, host)).toEqual({ kind: 'building', root: real(sub) });
    expect(queued).toEqual([real(anchor), real(sub)]);

    failed = true;
    expect(await ensureWorktreeIndex(sub, host, anchor)).toEqual({ kind: 'none', unbuilt: { root: real(anchor) } });
    expect(queued, 'a failed build is not queued again').toHaveLength(2);
  });

  it('the failed-build note says the build is not retried until the CodeGraph server restarts; a refused root names why', () => {
    expect(unbuiltDirectoryNote('/p/sub', '/p')).toContain('will not retry it until the CodeGraph server restarts');
    expect(unbuiltDirectoryNote('/p/sub', '/p', 'your home directory')).toContain('(your home directory)');
  });

  // A symlink spelling must not pick a different build root than the directory it names: /work/link ->
  // /work/nested-repo/src has no .git on its lexical path, so the plain-directory rule would build the
  // anchor /work, while the realpath spelling is inside the nested repository (nothing may be built at /work).
  it('a symlink into a nested repository gets the answer of the real spelling: nothing is queued at the anchor', async () => {
    const work = path.join(workspace, 'work');
    const nested = path.join(work, 'nested-repo');
    const src = path.join(nested, 'src');
    fs.mkdirSync(src, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: nested, stdio: 'ignore' });
    const link = path.join(work, 'link');
    fs.symlinkSync(src, link);
    const queued: string[] = [];
    const host: SeedHost = {
      buildingRootFor: () => null,
      hasFailedBuild: () => false,
      queueColdBuild: (root) => { queued.push(root); },
      runSeed: async () => ({ done: false as const }),
    };

    const viaLink = await ensureWorktreeIndex(link, host, work);
    const viaReal = await ensureWorktreeIndex(src, host, work);

    expect(queued, 'nothing is built at the anchor').not.toContain(real(work));
    expect(viaLink, 'both spellings get one answer').toEqual(viaReal);
    expect(viaLink).toEqual({ kind: 'building', root: real(nested) });
    expect(queued).toEqual([real(nested), real(nested)]);
  });

  // A session launched in a sensitive folder that codegraph would otherwise index (`/tmp` is not home, a
  // filesystem root or a parent of home) is owed the reason, not the generic not-indexed text.
  it.runIf(process.platform !== 'win32')('a sensitive but otherwise safe anchor answers unbuilt with the sensitive-folder reason, and builds nothing', async () => {
    // A home that is not under /tmp (the suite's own home is, on Linux), so /tmp is not "a parent of home".
    vi.stubEnv('HOME', '/cg-no-home/user');
    vi.stubEnv('USERPROFILE', '/cg-no-home/user');
    const base = fs.mkdtempSync('/tmp/cg-sensitive-anchor-');
    try {
      const sub = path.join(base, 'sub');
      fs.mkdirSync(sub);
      const anchor = fs.realpathSync('/tmp');
      expect(unsafeIndexRootReason(anchor), 'premise: /tmp is not an unsafe index root').toBeNull();
      const reason = validateProjectPath(anchor);
      expect(reason, 'premise: /tmp is a sensitive folder').toMatch(/sensitive/);
      const svc = startService();

      expect(await svc.ensure(sub, '/tmp')).toEqual({ kind: 'none', unbuilt: { root: anchor, unsafe: reason } });
      expect(jobLines, 'no job was queued').toEqual([]);
      expect(fs.existsSync(path.join(anchor, '.codegraph'))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  // ---- a git repository nested in an indexed checkout (the outer checkout's index is another repository's) ----

  /** One git repository with a commit: `git init`, then everything added and committed. */
  function commitAll(dir: string): void {
    const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', [...identity, 'commit', '-q', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  }

  /**
   * An outer checkout, indexed, with `nested/` gitignored by it, and a separate git repository inside at `nested/`
   * with `src/`. Returns the realpaths.
   */
  async function outerAndNested(): Promise<{ outer: string; nested: string; src: string }> {
    const outer = path.join(workspace, 'outer');
    const nested = path.join(outer, 'nested');
    const src = path.join(nested, 'src');
    fs.mkdirSync(path.join(outer, 'src'), { recursive: true });
    fs.writeFileSync(path.join(outer, '.gitignore'), 'nested/\n');
    fs.writeFileSync(path.join(outer, 'src', 'base.ts'), 'export function baseSymbol() { return 1; }\n');
    commitAll(outer);
    const cg = await CodeGraph.init(outer);
    try { await cg.indexAll(); } finally { cg.close(); }
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'nested.ts'), 'export function nestedSymbol() { return 2; }\n');
    commitAll(path.join(outer, 'nested'));
    return { outer: real(outer), nested: real(nested), src: real(src) };
  }

  /** What a build killed mid-index leaves behind: an index whose state is 'indexing' and a rebuild.pid naming a dead pid. */
  function plantAbandonedIndex(root: string): void {
    CodeGraph.initSync(root).close();
    const db = new DatabaseSync(path.join(root, '.codegraph', 'codegraph.db'));
    try {
      db.prepare("INSERT OR REPLACE INTO project_metadata (key, value, updated_at) VALUES ('index_state', 'indexing', ?)").run(Date.now());
    } finally {
      db.close();
    }
    fs.writeFileSync(
      path.join(root, '.codegraph', 'rebuild.pid'),
      JSON.stringify({ pid: DEAD_PID, mode: 'cold-build', startedAt: Date.now(), root }) + '\n',
    );
  }

  /** A SeedHost with nothing queued and no sibling: a cold build is recorded, never run. */
  function recordingHost(queued: string[]): SeedHost {
    return {
      buildingRootFor: () => null,
      hasFailedBuild: () => false,
      queueColdBuild: (root) => { queued.push(root); },
      runSeed: async () => ({ done: false as const }),
    };
  }

  // The outer checkout's index does not cover this repository (it gitignores nested/): a call for a path in the nested repository
  // is about that repository's own index, which it has none of, so the builder queues a cold build of it.
  it('a nested repository with no index of its own is queued for a cold build of its own (not answered none, not built at the outer checkout)', async () => {
    const { outer, nested, src } = await outerAndNested();
    expect(fs.existsSync(path.join(nested, '.codegraph')), 'premise: the nested repository has no index').toBe(false);
    expect(fs.existsSync(path.join(outer, '.codegraph', 'codegraph.db')), 'premise: the outer checkout is indexed').toBe(true);
    const queued: string[] = [];

    expect(await ensureWorktreeIndex(src, recordingHost(queued), nested)).toEqual({ kind: 'building', root: nested });
    expect(queued).toEqual([nested]);
    expect(queued, 'the outer checkout is not built for the nested path').not.toContain(outer);
  });

  it('a nested repository whose own index a killed build left behind is answered building for itself, not none', async () => {
    const { nested, src } = await outerAndNested();
    plantAbandonedIndex(nested);
    expect(pidAlive(DEAD_PID), 'premise: the pid is dead').toBe(false);
    expect(isAbandonedIndex(nested), 'premise: the nested index is abandoned').toBe(true);
    const queued: string[] = [];

    expect(await ensureWorktreeIndex(src, recordingHost(queued), nested)).toEqual({ kind: 'building', root: nested });
    expect(queued).toEqual([nested]);
  });

  it('a build queued for the outer checkout does not name a path in its nested repository: the nested repository is queued itself', async () => {
    const { outer, nested, src } = await outerAndNested();
    const queue = new JobQueue();
    const host = new BuilderSeedHost(queue, { seedWaitMs: 1_000 });
    // A job that does not end holds the queue, so the outer checkout's cold build stays queued (nothing runs a build).
    let finishBlocker!: () => void;
    const blocker = queue.enqueue('cold-build', '/blocker', () => new Promise<void>((resolve) => { finishBlocker = resolve; }));
    await waitUntil(() => queue.runningJob()?.root === '/blocker', 2_000);
    try {
      host.queueColdBuild(outer, { realRoot: outer, plain: false });
      expect(host.buildingRootFor(outer)).toBe(outer);
      expect(host.buildingRootFor(src), 'the outer checkout\'s build does not name a path in the nested repository').toBeNull();

      expect(await ensureWorktreeIndex(src, host, nested)).toEqual({ kind: 'building', root: nested });
      expect(host.buildingRootFor(src)).toBe(nested);
      expect(queue.waiting().cold, 'the outer build and the nested build both wait').toBe(2);
    } finally {
      // Dropping the queue rejects the two waiting builds (nothing runs them); the blocker then ends.
      const closing = queue.close();
      finishBlocker();
      await closing;
      await blocker;
    }
  });

  it('with CODEGRAPH_NO_AUTO_SEED=1, a call for a path in the nested repository holds no index of the outer checkout', async () => {
    const { outer, nested, src } = await outerAndNested();
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '1');
    const svc = startService();

    expect(await svc.ensure(src, nested)).toEqual({ kind: 'none' });
    expect(svc.holders.has(outer), 'the outer checkout is not held for a path in the nested repository').toBe(false);
    expect(readWriterLock(outer), 'the outer checkout\'s writer slot is not taken').toBeNull();
  });

  // A git that could not run is "could not ask", not "no worktree": the builder must ask again on the next call,
  // not keep answering none for the path until it restarts.
  it('a nested repository asked about while git cannot run answers none, and is queued for its own build once git is back', async () => {
    const { nested, src } = await outerAndNested();
    const queued: string[] = [];
    const host = recordingHost(queued);

    const savedPath = process.env.PATH;
    const noGit = path.join(workspace, 'no-git-here');
    fs.mkdirSync(noGit, { recursive: true });
    let whileBroken: Awaited<ReturnType<typeof ensureWorktreeIndex>>;
    try {
      process.env.PATH = noGit;
      whileBroken = await ensureWorktreeIndex(src, host, nested);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }

    expect(whileBroken, 'git could not run: nothing can be seeded or built').toEqual({ kind: 'none' });
    expect(queued).toEqual([]);
    expect(await ensureWorktreeIndex(src, host, nested), 'with git back the same path is asked about again').toEqual({ kind: 'building', root: nested });
    expect(queued).toEqual([nested]);
  });

  it('the not-yet-seeded note for a worktree names the worktree and never calls indexing the user\'s decision', () => {
    const note = unseededWorktreeNote('/w/sub', '/w');
    expect(note).toContain("isn't indexed with codegraph");
    expect(note).not.toContain("user's decision");
  });
});
