/**
 * The project writer lock under the machine server (#1740, #1963).
 *
 * At most one process writes a project's index: the one that holds the
 * project's `writer.pid`. With one machine server per state dir, every proxy of
 * that state dir reaches the same server, and the server's index builder (a
 * child process of the server, src/extensions/host/builder/) alone claims the
 * project's writer slot, on the first call that names the project; the server
 * itself and the proxies claim none. An engine with a builder only asks it; an
 * engine without one (the proxy's in-process fallback) is read-only: it answers
 * from the index as it is, with no watcher, no sync and no writer slot, so it can
 * never contend with the writer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { MCPEngine } from '../src/mcp/engine';
import type { BuilderClient } from '../src/extensions/host/builder/client';

import { createDatabase } from '../src/db/sqlite-adapter';
import { getWriterPidPath, readWriterLock } from '../src/mcp/writer-lock';
import { isProcessAlive, readServerLock, stopServer } from '../src/mcp/server-control';
import { recordSpawns, removeSpawnLog, settleLosingCandidates } from './daemon-candidates';
import { ADMIT_ALL } from './helpers/admit-all';

// Exercise the shipped lazy CommonJS loader as well as the engine lifecycle.
const { MCPEngine: BuiltMCPEngine } = require('../dist/mcp/engine') as typeof import('../src/mcp/engine');

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Launcher {
  child: ChildProcessWithoutNullStreams;
  getStderr: () => string;
  send: (msg: unknown) => void;
  replied: (id: number) => boolean;
}

function spawnMcp(cwd: string, env: NodeJS.ProcessEnv): Launcher {
  // Record the server candidates this launcher spawns, for the teardown.
  const recorder = recordSpawns(cwd);
  const child = spawn(process.execPath, [...recorder.args, BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...recorder.env, ...env },
  }) as ChildProcessWithoutNullStreams;
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
  return {
    child,
    getStderr: () => stderr,
    send: (msg) => { child.stdin.write(JSON.stringify(msg) + '\n'); },
    replied: (id) => stdout.split('\n').some((l) => {
      try { return (JSON.parse(l) as { id?: unknown }).id === id; } catch { return false; }
    }),
  };
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (exited()) return;
    child.kill(signal);
    const deadline = Date.now() + 3000;
    while (!exited() && Date.now() < deadline) await sleep(25);
  }
  expect(exited(), `Child ${child.pid} did not exit`).toBe(true);
}

/** The builder pid the server's builder recorded in `<state dir>/builder.pid`, or null. */
function readBuilderPid(stateDir: string): number | null {
  try {
    const pid = (JSON.parse(fs.readFileSync(path.join(stateDir, 'builder.pid'), 'utf8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' ? pid : null;
  } catch {
    return null;
  }
}

describe('machine server — one writer per project, the builder (#1740)', () => {
  let tempDir: string;
  let realRoot: string;
  let stateDir: string;
  let priorStateDir: string | undefined;
  let cleanedUp = false;
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeEach(async () => {
    cleanedUp = false;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg1740-mcp-'));
    realRoot = fs.realpathSync(tempDir);
    fs.mkdirSync(path.join(realRoot, 'src'));
    fs.writeFileSync(path.join(realRoot, 'src/a.ts'), 'export function a() { return 1; }\n');
    const cg = await CodeGraph.init(realRoot);
    await cg.indexAll();
    cg.close();
    // The launchers, the server they spawn and the server-control calls here
    // all read the state dir from this variable.
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg1740-state-')));
    priorStateDir = process.env.CODEGRAPH_STATE_DIR;
    process.env.CODEGRAPH_STATE_DIR = stateDir;
  });

  async function cleanup(): Promise<void> {
    // Runs once per test (the test calls it, then afterEach): a second run
    // would act on the restored state dir, which may be the real one.
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      // Capture the server before stopping its proxies (#1782). stopServer
      // verifies its socket identity before signaling it.
      const childPids = new Set(children.map((c) => c.pid));
      const serverPid = readServerLock()?.pid;
      // With the launchers gone no new server candidate can appear. A loser can
      // still be starting on a loaded machine; stopping the winner first would
      // let it take over the state dir being removed (#1773).
      const stopWriter = async (): Promise<void> => {
        await settleLosingCandidates(realRoot, () => readServerLock()?.pid);
        if (serverPid === undefined || childPids.has(serverPid)) return;
        const result = await stopServer();
        expect(result.pid).toBe(serverPid);
        expect(result.outcome).toBe('stopped');
      };
      const results = [
        ...await Promise.allSettled(children.map(stopChild)),
        ...await Promise.allSettled([stopWriter()]),
      ];
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
      }
      if (serverPid !== undefined) {
        expect(isProcessAlive(serverPid), `Server ${serverPid} did not exit`).toBe(false);
      }
      children.length = 0;
      removeSpawnLog(realRoot);
      // A stopped server's files can stay held for a moment (handle rundown, an
      // antivirus scan on close) with nothing to wait on. fs.rmSync gives up on
      // the first Windows access-denied error despite maxRetries (Node 24), so
      // use the asynchronous removal, which does back off and retry (#1773).
      await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await fs.promises.rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      expect(fs.existsSync(tempDir)).toBe(false);
    } finally {
      if (priorStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
      else process.env.CODEGRAPH_STATE_DIR = priorStateDir;
    }
  }

  afterEach(cleanup, 45_000);

  // Two launchers spawn the server, attach to it, and each makes a tool call
  // that opens the project there: a few seconds, so the 90s timeout is room for
  // a loaded machine, not the expected run.
  it('two proxies share one server, whose builder alone holds the project writer slot', async () => {
    const env = {
      CODEGRAPH_STATE_DIR: stateDir,
      CODEGRAPH_MCP_LOG_ATTACH: '1',
      CODEGRAPH_NO_WATCHDOG: '1',
      CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '0',
      // Avoid the wasm --liftoff-only re-exec so each launcher's pid is the
      // spawned child's.
      CODEGRAPH_NO_RELAUNCH: '1',
      CODEGRAPH_WASM_RELAUNCHED: '1',
    };
    const a = spawnMcp(realRoot, env);
    const b = spawnMcp(realRoot, env);
    children.push(a.child, b.child);

    // Attaching proves the server bound and rewrote server.pid, so cleanup never
    // probes a server that is still starting (#1773).
    const attached = () => [a, b].every((p) => p.getStderr().includes('Attached to shared daemon'));
    const attachDeadline = Date.now() + 30000;
    while (Date.now() < attachDeadline && !attached()) {
      await sleep(50);
    }
    expect(attached(), a.getStderr() + b.getStderr()).toBe(true);
    // The server opens nothing until a call names a project.
    expect(fs.existsSync(getWriterPidPath(realRoot))).toBe(false);

    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
    const search = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codegraph_search', arguments: { projectPath: realRoot, query: 'a' } } };
    for (const p of [a, b]) {
      p.send(initialize);
      p.send(search);
    }
    const replyDeadline = Date.now() + 30000;
    while (Date.now() < replyDeadline && !(a.replied(2) && b.replied(2))) {
      await sleep(50);
    }
    expect(a.replied(2) && b.replied(2), a.getStderr() + b.getStderr()).toBe(true);

    const server = readServerLock();
    expect(server).not.toBeNull();
    // The writer is the server's builder, a process of its own: never the
    // server, never a proxy.
    const lockDeadline = Date.now() + 15000;
    while (Date.now() < lockDeadline && (readBuilderPid(stateDir) === null || readWriterLock(realRoot) === null)) {
      await sleep(50);
    }
    const builderPid = readBuilderPid(stateDir);
    expect(builderPid, a.getStderr() + b.getStderr()).not.toBeNull();
    const writer = readWriterLock(realRoot);
    expect(writer?.pid).toBe(builderPid);
    expect(writer?.mode).toBe('builder');
    expect(writer?.pid).not.toBe(server!.pid);
    expect(writer?.pid).not.toBe(a.child.pid);
    expect(writer?.pid).not.toBe(b.child.pid);
    await sleep(1000);
    expect(a.child.exitCode).toBeNull();
    expect(b.child.exitCode).toBeNull();

    // This must catch a live writer even on POSIX, where unlinking its open
    // database would otherwise hide the leak that blocks removal on Windows.
    // The builder ends with its server.
    await cleanup();
    expect(isProcessAlive(builderPid!), `Builder ${builderPid} did not exit with its server`).toBe(false);
    expect(isProcessAlive(server!.pid)).toBe(false);
    expect(isProcessAlive(a.child.pid!)).toBe(false);
    expect(isProcessAlive(b.child.pid!)).toBe(false);
    expect(fs.existsSync(tempDir)).toBe(false);
  }, 90_000);
});


describe('the in-process fallback engine serves reads read-only (#1963)', () => {
  let root: string;
  let engine: MCPEngine;

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg1963-reader-')));
    fs.writeFileSync(path.join(root, 'app.ts'), 'export function originalSymbol() { return 1; }\n');
    const cg = await CodeGraph.init(root);
    try { await cg.indexAll(); } finally { cg.close(); }
  });

  afterEach(async () => {
    await engine?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['held by another process', 'free'] as const)('never updates the index or claims writer.pid while the writer slot is %s', async (slot) => {
    const lockPath = getWriterPidPath(root);
    const owner = JSON.stringify({ pid: process.pid, mode: 'fallback', startedAt: Date.now() });
    if (slot === 'held by another process') fs.writeFileSync(lockPath, owner);
    const lockState = () => (fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null);
    const expectedLock = slot === 'free' ? null : owner;
    fs.writeFileSync(path.join(root, 'app.ts'), 'export function changedSymbol() { return 2; }\n');
    const { db } = createDatabase(path.join(root, '.codegraph', 'codegraph.db'), { readOnly: true });
    const version = db.pragma('data_version', { simple: true });
    // No builder: the fallback engine has no one to write for it, and no
    // default project: the call names the one it reads.
    engine = new BuiltMCPEngine();
    try {
      const result = await engine.getToolHandler().execute('codegraph_search', { projectPath: root, query: 'originalSymbol' }, undefined, ADMIT_ALL);
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain('originalSymbol');
      fs.writeFileSync(path.join(root, 'added.ts'), 'export function addedSymbol() {}\n');
      // Longer than the builder's ownership retry (service.ts ownRetryMs, 1 s) and the
      // watcher's debounce: neither may run for a read-only engine.
      await sleep(2200);
      expect(db.pragma('data_version', { simple: true })).toBe(version);
      expect(lockState()).toBe(expectedLock);
      await engine.stop();
      expect(db.pragma('data_version', { simple: true })).toBe(version);
      expect(lockState()).toBe(expectedLock);
    } finally { db.close(); }
  });
});

describe('an engine with a builder asks it and never takes a lock or writes itself', () => {
  let root: string;
  let engine: MCPEngine;

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cgib-engine-')));
    fs.writeFileSync(path.join(root, 'app.ts'), 'export function originalSymbol() { return 1; }\n');
    const cg = await CodeGraph.init(root);
    try { await cg.indexAll(); } finally { cg.close(); }
  });

  afterEach(async () => {
    await engine?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * A builder that records what the engine asks of it and writes nothing (only its pid would ever be in a
   * lock): it reports a root as held, with nothing pending, from its `ensure` until its `release`.
   */
  function stubBuilder() {
    const calls: string[] = [];
    const held = new Set<string>();
    const builder = {
      ensure: async (projectPath: string) => { calls.push(`ensure ${projectPath}`); held.add(fs.realpathSync(projectPath)); return { kind: 'ready' as const, root: projectPath }; },
      caughtUp: async (r: string) => { calls.push(`caughtUp ${r}`); },
      sync: async (r: string) => { calls.push(`sync ${r}`); return { filesChanged: 0 }; },
      release: async (r: string) => { calls.push(`release ${r}`); held.delete(fs.realpathSync(r)); },
      freshness: (r: string) => (held.has(fs.realpathSync(r))
        ? { root: r, watching: true, degradedReason: null, recovering: false, pendingFiles: [] }
        : null),
    };
    return { calls, builder: builder as unknown as BuilderClient };
  }

  it('answers from the index, has the builder hold it, and takes no writer.pid, rebuild.pid or codegraph.lock itself', async () => {
    const { calls, builder } = stubBuilder();
    const codegraphDir = path.join(root, '.codegraph');
    const lockFiles = () => ['writer.pid', 'rebuild.pid', 'codegraph.lock'].filter((f) => fs.existsSync(path.join(codegraphDir, f)));
    const { db } = createDatabase(path.join(codegraphDir, 'codegraph.db'), { readOnly: true });
    const version = db.pragma('data_version', { simple: true });
    engine = new BuiltMCPEngine({ builder, queryPool: true });
    try {
      const result = await engine.getToolHandler().execute('codegraph_search', { projectPath: root, query: 'originalSymbol' }, undefined, ADMIT_ALL);
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain('originalSymbol');
      // The builder was asked to hold the root before the engine opened it, and its catch-up awaited.
      expect(calls[0]).toBe(`ensure ${root}`);
      expect(calls).toContain(`caughtUp ${root}`);
      // A second call on the held root costs no builder round trip: it asked once.
      calls.length = 0;
      await engine.getToolHandler().execute('codegraph_search', { projectPath: root, query: 'originalSymbol' }, undefined, ADMIT_ALL);
      expect(calls.filter((c) => c.startsWith('ensure'))).toEqual([]);
      // Edits and a wait past the builder's ownership retry (service.ts ownRetryMs, 1 s): the engine writes nothing.
      fs.writeFileSync(path.join(root, 'added.ts'), 'export function addedSymbol() {}\n');
      await sleep(2200);
      expect(lockFiles()).toEqual([]);
      expect(db.pragma('data_version', { simple: true })).toBe(version);
      // Releasing the root is the builder's to complete: engine.releaseProjectRoot awaits it.
      calls.length = 0;
      await engine.releaseProjectRoot(root);
      expect(calls).toContain(`release ${root}`);
      expect(lockFiles()).toEqual([]);
    } finally { db.close(); }
  });

  it('fresh: true syncs through the builder, never the engine', async () => {
    const { calls, builder } = stubBuilder();
    // The stub's sync does not index. It rewrites app.ts to the bytes beforeEach indexed, which is all the
    // measurement needs: getChangedFiles compares content hashes, so the rewritten file is not pending. The
    // call is still recorded, and the wait ends on nothing pending after that one sync.
    (builder as unknown as { sync: (r: string) => Promise<{ filesChanged: number }> }).sync = async (r: string) => {
      calls.push(`sync ${r}`);
      fs.writeFileSync(path.join(r, 'app.ts'), 'export function originalSymbol() { return 1; }\n');
      return { filesChanged: 1 };
    };
    engine = new BuiltMCPEngine({ builder });
    fs.writeFileSync(path.join(root, 'app.ts'), 'export function changedSymbol() { return 2; }\n');
    // The wait's clock starts before its first measurement, so that measurement and each sync count against
    // the bound. On a loaded machine a short bound could run out before the first sync is asked for. The 30 s
    // bound is a backstop the wait does not reach here, since one sync ends it.
    const prior = process.env.CODEGRAPH_FRESH_TIMEOUT_MS;
    process.env.CODEGRAPH_FRESH_TIMEOUT_MS = '30000';
    try {
      const result = await engine.getToolHandler().execute('codegraph_search', { projectPath: root, query: 'originalSymbol', fresh: true }, undefined, ADMIT_ALL);
      expect(result.isError).not.toBe(true);
      expect(calls.some((c) => c === `sync ${root}`)).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.CODEGRAPH_FRESH_TIMEOUT_MS;
      else process.env.CODEGRAPH_FRESH_TIMEOUT_MS = prior;
    }
  });
});
