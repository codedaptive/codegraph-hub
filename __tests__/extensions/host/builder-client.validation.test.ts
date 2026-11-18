/**
 * The index builder process through its client (src/extensions/host/builder/client.ts): the real compiled
 * builder (dist/extensions/host/builder/main.js, which the suite's global setup rebuilds when src/ changed),
 * forked over IPC, against throwaway repositories with CODEGRAPH_STATE_DIR in a temp dir.
 *
 * What is pinned here is what only a separate process shows: held roots name the builder as their writer,
 * and a cold build's `rebuild.pid` names the builder or its child, never this (the server's) process; a sync, a hold and a
 * release do what the client's contract says; a plain directory is not built; a builder
 * started on a closed channel exits 0; stop() ends the builder. The SIGKILL case for held roots and dead locks
 * is in builder-client-sigkill.validation.test.ts.
 *
 * Over 5 s per case by design: each starts a builder process (it loads the whole engine) and a repository,
 * and some wait for an index build on an overloaded machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, fork } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { isInitialized } from '../../../src/directory';
import { BuilderClient, builderEntry } from '../../../src/extensions/host/builder/client';
import { NODE_RUNTIME_FLAGS, WASM_RUNTIME_FLAGS } from '../../../src/extraction/wasm-runtime-flags';
import { readWriterLock } from '../../../src/mcp/writer-lock';
import { parentPid } from '../../helpers/parent-pid';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function real(p: string): string {
  return fs.realpathSync(path.resolve(p));
}

function makeRepo(dir: string, body = 'export function baseSymbol() { return 1; }\n'): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'src', 'base.ts'), body);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

async function indexDir(dir: string): Promise<void> {
  const cg = await CodeGraph.init(dir);
  try { await cg.indexAll(); } finally { cg.close(); }
}

async function waitUntil(check: () => boolean, timeoutMs: number, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return check();
}

function builderLog(stateDir: string): string[] {
  try {
    return fs.readFileSync(path.join(stateDir, 'builder.log'), 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
}

function pidFilePid(stateDir: string): number | null {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(stateDir, 'builder.pid'), 'utf8')) as { pid?: unknown };
    return typeof record.pid === 'number' ? record.pid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Engine startup, builds and replacement processes can each take minutes at host load 175; wait on events.
describe('the index builder process, through BuilderClient', { timeout: 600_000 }, () => {
  let workspace: string;
  let stateDir: string;
  let client: BuilderClient | undefined;

  beforeEach(() => {
    // Plain-directory cases must be outside git and indexed ancestors; the harness's POSIX TMPDIR can be in a checkout.
    workspace = real(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cg-builder-client-')));
    stateDir = path.join(workspace, 'state');
    // The builder is forked with this environment.
    vi.stubEnv('CODEGRAPH_STATE_DIR', stateDir);
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    vi.stubEnv('CODEGRAPH_WATCH_DEBOUNCE_MS', '100');
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '');
  });

  afterEach(async () => {
    await client?.stop();
    client = undefined;
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 180_000);

  // slow: forks a real builder that loads the engine; indexing and IPC wait for host CPU under heavy load.
  it('holds an indexed root as the builder: writer.pid names the builder, a sync and a release do what they say', async () => {
    const root = path.join(workspace, 'repo');
    makeRepo(root);
    await indexDir(root);
    client = BuilderClient.start();
    expect(await waitUntil(() => client?.isUp() === true, 120_000)).toBe(true);

    const outcome = await client.ensure(root);
    expect(outcome).toEqual({ kind: 'ready', root: real(root) });
    const builderPid = client.pid();
    expect(builderPid).not.toBeNull();
    expect(builderPid).not.toBe(process.pid);
    // The writer slot is the builder's, never this process's.
    expect(readWriterLock(root)?.pid).toBe(builderPid);
    expect(readWriterLock(root)?.mode).toBe('builder');
    // builder.pid says who the builder is and whose server it serves.
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'builder.pid'), 'utf8'))).toMatchObject({ pid: builderPid, serverPid: process.pid });

    // Resolves once the first catch-up has run, and marks the writer ready.
    await client.caughtUp(root);
    expect(await waitUntil(() => readWriterLock(root)?.ready === true, 120_000)).toBe(true);
    expect(builderLog(stateDir).some((l) => / job end catch-up \S+ ok$/.test(l))).toBe(true);

    // The watcher state is pushed: watching, nothing pending.
    expect(await waitUntil(() => client!.freshness(root)?.watching === true, 120_000)).toBe(true);
    expect(client.freshness(root)).toMatchObject({ root: real(root), degradedReason: null, recovering: false, pendingFiles: [] });

    // An edit, then a sync job: counted, logged as the builder's job, and visible to a read-only open.
    fs.writeFileSync(path.join(root, 'src', 'base.ts'), 'export function baseSymbol() { return 1; }\nexport function editedSymbol() { return 2; }\n');
    const { filesChanged } = await client.sync(root);
    expect(filesChanged).toBeGreaterThanOrEqual(0);
    const reader = CodeGraph.openSync(root, { readOnly: true });
    try {
      expect(reader.searchNodes('editedSymbol').length).toBeGreaterThan(0);
    } finally {
      reader.close();
    }
    expect(builderLog(stateDir).some((l) => / job end (sync|watch-sync) \S+ ok$/.test(l))).toBe(true);

    // Release resolves after the builder let go: the slot is free for a CLI.
    await client.release(root);
    expect(readWriterLock(root)).toBeNull();
    expect(client.freshness(root)).toBeNull();
    // A root that is not held: caughtUp returns at once, sync rejects.
    await client.caughtUp(root);
    await expect(client.sync(root)).rejects.toThrow(/not held/);
  });

  // slow: forks a real builder that loads the engine; indexing and IPC wait for host CPU under heavy load.
  it('cold-builds a worktree with no index and no sibling under rebuild.pid held by the builder or its cold-build child, no opt-in needed', async () => {
    const main = path.join(workspace, 'main');
    makeRepo(main);
    const wt = path.join(workspace, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
    vi.stubEnv('CODEGRAPH_BUILDER_COLD_BUILD_DELAY_MS', '1500');
    client = BuilderClient.start();
    expect(await waitUntil(() => client?.isUp() === true, 120_000)).toBe(true);

    const first = await client.ensure(wt);
    expect(first).toEqual({ kind: 'building', root: real(wt) });
    // The build holds rebuild.pid for the delay: the holder is the builder or its child.
    const builderPid = client.pid();
    expect(builderPid).not.toBeNull();
    const observed: { lock: ReturnType<typeof readWriterLock>; parent: number | null } = { lock: null, parent: null };
    expect(await waitUntil(() => {
      const lock = readWriterLock(wt, 'rebuild.pid');
      if (!lock) return false;
      if (lock.pid === builderPid) {
        observed.lock = lock;
        observed.parent = builderPid;
        return true;
      }
      // Null only when the holder is already gone (keep waiting for the next one); a broken probe throws.
      const parent = parentPid(lock.pid);
      if (parent === null) return false;
      observed.parent = parent;
      observed.lock = lock;
      return true;
    }, 120_000)).toBe(true);
    expect(observed.parent).toBe(builderPid);
    expect(observed.lock?.mode).toBe('cold-build');
    // A second call for the same worktree while it builds queues no second build.
    expect(await client.ensure(path.join(wt, 'src'))).toEqual({ kind: 'building', root: real(wt) });

    expect(await waitUntil(() => isInitialized(wt) && readWriterLock(wt, 'rebuild.pid') === null, 180_000)).toBe(true);
    // The child releases rebuild.pid before the builder logs the job's end, so wait for that line.
    expect(await waitUntil(() => builderLog(stateDir).some((l) => / job end cold-build \S+ ok$/.test(l)), 120_000)).toBe(true);
    const log = builderLog(stateDir);
    expect(log.filter((l) => / job start cold-build /.test(l))).toHaveLength(1);
    expect(log.some((l) => / job end cold-build \S+ ok$/.test(l))).toBe(true);

    // Now it is an index of its own: held, ready.
    expect(await client.ensure(wt)).toEqual({ kind: 'ready', root: real(wt) });
    expect(readWriterLock(wt)?.pid).toBe(client.pid());
  });

  // slow: forks a real builder that loads the engine; indexing and IPC wait for host CPU under heavy load.
  it('answers none, never an error, for a path that does not exist', async () => {
    client = BuilderClient.start();
    expect(await waitUntil(() => client?.isUp() === true, 120_000)).toBe(true);
    await expect(client.ensure(path.join(workspace, 'missing'))).resolves.toEqual({ kind: 'none' });
  });

  it('does not build a directory outside git', async () => {
    const plain = path.join(workspace, 'plain');
    fs.mkdirSync(path.join(plain, 'src'), { recursive: true });
    fs.writeFileSync(path.join(plain, 'src', 'a.ts'), 'export function plainSymbol() { return 1; }\n');
    client = BuilderClient.start();
    expect(await waitUntil(() => client?.isUp() === true, 120_000)).toBe(true);

    expect(await client.ensure(plain)).toEqual({ kind: 'none' });
    expect(fs.existsSync(path.join(plain, '.codegraph'))).toBe(false);
    expect(builderLog(stateDir).filter((l) => / job start cold-build /.test(l))).toEqual([]);
  });

  it('does not build a subdirectory outside git', async () => {
    const plain = path.join(workspace, 'plain');
    const sub = path.join(plain, 'src');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'a.ts'), 'export function plainSymbol() { return 1; }\n');
    client = BuilderClient.start();
    expect(await waitUntil(() => client?.isUp() === true, 120_000)).toBe(true);

    expect(await client.ensure(sub)).toEqual({ kind: 'none' });
    expect(fs.existsSync(path.join(plain, '.codegraph'))).toBe(false);
    expect(fs.existsSync(path.join(sub, '.codegraph'))).toBe(false);
    expect(builderLog(stateDir).filter((l) => / job start cold-build /.test(l))).toEqual([]);
  });

  // The channel is closed before the builder has started, so its `ready` message is written to a pipe nobody
  // reads: the write fails (EPIPE) asynchronously to the send call. Before the fix that became an unhandled
  // 'error' event on `process`, exit code 1, builder.pid left behind.
  // slow: forks a real builder that loads the engine; indexing and IPC wait for host CPU under heavy load.
  it('a builder started on an already closed channel shuts down normally: exit 0, no unhandled EPIPE, builder.pid removed', async () => {
    const entry = builderEntry();
    expect(entry).not.toBeNull();
    const child = fork(entry!, [], {
      execArgv: [...WASM_RUNTIME_FLAGS, ...NODE_RUNTIME_FLAGS],
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    child.disconnect();
    try {
      expect(await exited).toEqual({ code: 0, signal: null });
    } finally {
      child.kill('SIGKILL');
    }
    expect(stderr).not.toMatch(/Unhandled 'error' event|EPIPE/);
    expect(pidFilePid(stateDir)).toBeNull();
  });

  // slow: forks a real builder that loads the engine; indexing and IPC wait for host CPU under heavy load.
  it('stop() ends the builder and removes builder.pid', async () => {
    client = BuilderClient.start();
    expect(await waitUntil(() => client?.isUp() === true, 120_000)).toBe(true);
    await client.ensure(path.join(workspace, 'nothing'));
    expect(await waitUntil(() => pidFilePid(stateDir) !== null, 120_000)).toBe(true);
    const pid = client.pid()!;
    await client.stop();
    expect(await waitUntil(() => !alive(pid), 120_000)).toBe(true);
    expect(pidFilePid(stateDir)).toBeNull();
    // After stop nothing restarts it, and a request answers as failed.
    expect(client.pid()).toBeNull();
    await expect(client.ensure(workspace)).resolves.toEqual({ kind: 'none' });
  });
});
