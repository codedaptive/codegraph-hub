/**
 * Two takers racing on one stale lock: exactly one acquires. A stale-lock
 * takeover is atomic with respect to a competing taker.
 *
 * The race: taker B judges a lock stale (its pid is dead) and calls
 * `fs.unlinkSync(lockPath)`. Between B's judgement and B's unlink, competitor
 * A removes the same stale lock and writes its own fresh one. B's unlink then
 * removes A's FRESH lock, and both A and B go on to write: two holders.
 *
 * Mechanism, deterministic and independent of the implementation: B runs in
 * this process. `fs.unlinkSync` is spied; on the FIRST call whose argument is
 * exactly the lock path, the spy runs competitor A to completion in a separate
 * process (fixtures/lock-takeover-competitor.ts, the real code from src, run
 * by the running node binary on fixtures/run-ts.cjs: see competitorLaunch),
 * and only then performs B's real unlink. Acquisitions are counted
 * across A and B; exactly one may succeed. A plain check-then-unlink counts
 * 2. B holds the `${lockPath}.takeover` guard while it unlinks, so A finds the
 * guard busy, does not take the lock, and the count is 1.
 *
 * The spy intercepts `fs.unlinkSync(lockPath)` with the exact path string the
 * caller computes (getWriterPidPath / the FileLock path / getServerPidPath).
 * That is the contract's requirement on src/mcp/lock-takeover.ts.
 *
 * Each case spawns one node process that loads the real src code (longer
 * under load), so each test is given a 60 s timeout and the competitor a 45 s
 * one; a hung competitor fails the test with the execFileSync error instead
 * of hanging the run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileLock } from '../../../src/utils';
import { getCodeGraphDir } from '../../../src/directory';
import { tryAcquireWriterLock, getWriterPidPath, lockStamp, isForeignLockRecord } from '../../../src/mcp/writer-lock';
import { clearStaleDaemonLock, tryAcquireDaemonLock } from '../../../src/mcp/daemon';
import { encodeServerLock, getServerPidPath, getServerSocketPath, decodeServerLock } from '../../../src/mcp/daemon-paths';

// A writable copy of the fs namespace, shared by this file and every src
// module it loads, so vi.spyOn(fs, 'unlinkSync') reaches the code under test
// (the ESM namespace of the builtin cannot be redefined).
vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>() }));

const REPO = path.resolve(__dirname, '../../..');

/** The runner that loads a TypeScript fixture in a plain node process (fixtures/run-ts.cjs). */
const TS_RUNNER = path.join(__dirname, 'fixtures', 'run-ts.cjs');
const COMPETITOR = path.join(__dirname, 'fixtures', 'lock-takeover-competitor.ts');
const COMPETITOR_TIMEOUT_MS = 45_000;
const TEST_TIMEOUT_MS = 60_000;

interface CompetitorResult {
  acquired: boolean;
  record?: { pid: number } | null;
  /** FileLock's "locked by another process" message, when it lost. */
  held?: string;
}

/**
 * Parse the competitor's last stdout line, and refuse anything but a
 * well-formed result: `acquired` must be a boolean and there must be no
 * `error` field. A crashed or malformed competitor then throws here (and is
 * recorded as `hook.error`) instead of counting as "did not acquire", which
 * would make every race case pass on B's single acquisition.
 */
function parseCompetitorOutput(out: string): CompetitorResult {
  const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
  const parsed = JSON.parse(line) as unknown;
  if (parsed === null || typeof parsed !== 'object') throw new Error(`competitor printed no result object: ${line}`);
  const r = parsed as Record<string, unknown>;
  if (typeof r.acquired !== 'boolean') throw new Error(`competitor result has no boolean "acquired": ${line}`);
  if ('error' in r) throw new Error(`competitor reported an error: ${line}`);
  return r as unknown as CompetitorResult;
}

/** A pid that was alive a moment ago and is now dead: a just-exited child's. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  if (typeof r.pid !== 'number' || r.pid <= 0) throw new Error('could not obtain a dead pid');
  return r.pid;
}

/**
 * The executable execFileSync runs for competitor A, and its arguments: the
 * running node binary on run-ts.cjs. Never a `#!` script or a `node_modules/.bin`
 * shim, which Windows cannot execute (see the harness test).
 */
function competitorLaunch(kind: string, arg: string, pid: number): { file: string; args: string[] } {
  return { file: process.execPath, args: [TS_RUNNER, COMPETITOR, '--', kind, arg, String(pid)] };
}

/** The first `n` bytes of `file`, as latin1 text. */
function firstBytes(file: string, n: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read).toString('latin1');
  } finally {
    fs.closeSync(fd);
  }
}

function runCompetitor(kind: string, arg: string, pid: number): CompetitorResult {
  const { file, args } = competitorLaunch(kind, arg, pid);
  const out = execFileSync(file, args, {
    cwd: REPO,
    env: { ...process.env, CODEGRAPH_STATE_DIR: stateDir },
    encoding: 'utf8',
    timeout: COMPETITOR_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return parseCompetitorOutput(out);
}

/**
 * Spy on fs.unlinkSync so the first unlink of exactly `lockPath` runs
 * competitor A before the real unlink. Errors raised by A are recorded, not
 * thrown: the code under test swallows errors around its unlink, which would
 * hide a broken harness as a pass.
 */
function hookFirstUnlink(lockPath: string, kind: string, arg: string, pid: number) {
  const state: { ran: boolean; result: CompetitorResult | null; error: unknown } = {
    ran: false,
    result: null,
    error: null,
  };
  const realUnlink = fs.unlinkSync.bind(fs);
  vi.spyOn(fs, 'unlinkSync').mockImplementation((p: fs.PathLike) => {
    if (!state.ran && String(p) === lockPath) {
      state.ran = true;
      try {
        state.result = runCompetitor(kind, arg, pid);
      } catch (err) {
        state.error = err;
      }
    }
    return realUnlink(p);
  });
  return state;
}

let root: string;
let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lock-race-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lock-race-state-'));
  previousStateDir = process.env.CODEGRAPH_STATE_DIR;
  process.env.CODEGRAPH_STATE_DIR = stateDir;
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
  else process.env.CODEGRAPH_STATE_DIR = previousStateDir;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('stale-lock takeover race (gate)', () => {
  // May exceed 5 s: a separate node competitor loads the real writer-lock code.
  it('writer.pid: exactly one of two racing takers acquires via tryAcquireWriterLock', () => {
    const dead = deadPid();
    const pidPath = getWriterPidPath(root);
    fs.writeFileSync(pidPath, JSON.stringify({ pid: dead, mode: 'fallback', startedAt: 1 }));

    const hook = hookFirstUnlink(pidPath, 'writer', root, dead);
    const b = tryAcquireWriterLock(root, 'fallback');

    expect(hook.error).toBeNull();
    expect(hook.ran).toBe(true);
    const acquisitions = (hook.result!.acquired ? 1 : 0) + (b.kind === 'acquired' ? 1 : 0);
    expect(acquisitions).toBe(1);
  }, TEST_TIMEOUT_MS);

  // May exceed 5 s: a separate node competitor runs inside the unlink hook.
  it('codegraph.lock: exactly one of two racing takers acquires via FileLock.acquire (no owner)', () => {
    const dead = deadPid();
    const lockPath = path.join(getCodeGraphDir(root), 'codegraph.lock');
    fs.writeFileSync(lockPath, String(dead));

    const hook = hookFirstUnlink(lockPath, 'filelock', lockPath, dead);
    let bAcquired = false;
    try {
      new FileLock(lockPath).acquire();
      bAcquired = true;
    } catch (err) {
      expect((err as Error).message).toContain('locked by another process');
    }

    expect(hook.error).toBeNull();
    expect(hook.ran).toBe(true);
    const acquisitions = (hook.result!.acquired ? 1 : 0) + (bAcquired ? 1 : 0);
    expect(acquisitions).toBe(1);
  }, TEST_TIMEOUT_MS);

  // May exceed 5 s: the competitor loads project-stamp-aware FileLock in another process.
  it('codegraph.lock: exactly one of two racing takers acquires via FileLock.acquire (with owner)', () => {
    const dead = deadPid();
    const lockPath = path.join(getCodeGraphDir(root), 'codegraph.lock');
    fs.writeFileSync(lockPath, `${dead}\n${JSON.stringify(lockStamp(root))}`);
    const owner = { stamp: () => lockStamp(root), isForeign: (r: unknown) => isForeignLockRecord(r, root) };

    const hook = hookFirstUnlink(lockPath, 'filelock-owner', root, dead);
    let bAcquired = false;
    try {
      new FileLock(lockPath, owner).acquire();
      bAcquired = true;
    } catch (err) {
      expect((err as Error).message).toContain('locked by another process');
    }

    expect(hook.error).toBeNull();
    expect(hook.ran).toBe(true);
    const acquisitions = (hook.result!.acquired ? 1 : 0) + (bAcquired ? 1 : 0);
    expect(acquisitions).toBe(1);
  }, TEST_TIMEOUT_MS);

  // May exceed 5 s: the competitor loads the real MCP engine in a separate process.
  it("server.pid: competitor's fresh record survives clearStaleDaemonLock, exactly one acquires", () => {
    const dead = deadPid();
    const pidPath = getServerPidPath();
    fs.writeFileSync(pidPath, encodeServerLock({
      pid: dead,
      version: '0.0.0',
      socketPath: getServerSocketPath(),
      startedAt: 1,
      stateDir,
    }));

    const hook = hookFirstUnlink(pidPath, 'daemon', stateDir, dead);
    clearStaleDaemonLock(pidPath, dead);

    expect(hook.error).toBeNull();
    expect(hook.ran).toBe(true);
    const a = hook.result!;
    if (a.acquired) {
      // A's fresh record must still be in place after B's clear.
      expect(fs.existsSync(pidPath)).toBe(true);
      expect(decodeServerLock(fs.readFileSync(pidPath, 'utf8'))?.pid).toBe(a.record!.pid);
    }
    const b = tryAcquireDaemonLock();
    const acquisitions = (a.acquired ? 1 : 0) + (b.kind === 'acquired' ? 1 : 0);
    expect(acquisitions).toBe(1);
  }, TEST_TIMEOUT_MS);
});

/**
 * The harness itself: a competitor that crashes, or prints a malformed result,
 * must never count as "did not acquire". If it did, every race case above
 * would pass on B's single acquisition whatever the lock code does.
 */
describe('stale-lock takeover race (harness)', () => {
  /**
   * execFileSync runs `launch.file` directly, with no shell. On Windows that
   * is CreateProcess, which starts native executables only: an npm
   * `node_modules/.bin` entry there is a `#!/bin/sh` script beside its .cmd
   * and .ps1 shims. So the launcher must be the running node binary, given
   * run-ts.cjs as its first argument. The `#!` check holds on every platform,
   * so it is asserted here rather than gated to Windows. The launcher is then
   * run for real: the competitor, a separate process, takes a free lock
   * through it. That process start can exceed 5 s under machine load.
   */
  it('launches the competitor as the running node binary on run-ts.cjs, never a #! script', () => {
    const lockPath = path.join(getCodeGraphDir(root), 'codegraph.lock');
    const launch = competitorLaunch('filelock', lockPath, 0);

    expect(firstBytes(launch.file, 2)).not.toBe('#!');
    expect(launch.file).toBe(process.execPath);
    expect(launch.args).toEqual([TS_RUNNER, COMPETITOR, '--', 'filelock', lockPath, '0']);
    expect(fs.statSync(TS_RUNNER).isFile()).toBe(true);

    expect(runCompetitor('filelock', lockPath, 0)).toEqual({ acquired: true });
    // The competitor's own pid, written by the real FileLock in that process.
    const holder = fs.readFileSync(lockPath, 'utf8');
    expect(holder).toMatch(/^\d+$/);
    expect(Number(holder)).not.toBe(process.pid);
  }, TEST_TIMEOUT_MS);

  // May exceed 5 s: this intentionally starts and observes a failing node competitor.
  it('a competitor that hits an unexpected error is recorded as hook.error, with no result', () => {
    const dead = deadPid();
    const lockPath = path.join(getCodeGraphDir(root), 'codegraph.lock');
    fs.writeFileSync(lockPath, String(dead));
    // A's lock path is under a directory that does not exist: its temp-file
    // create fails with ENOENT, which is not FileLock's "held" error, so the
    // competitor exits non-zero and runCompetitor throws.
    const missing = path.join(root, 'no-such-dir', 'codegraph.lock');

    const hook = hookFirstUnlink(lockPath, 'filelock', missing, dead);
    new FileLock(lockPath).acquire();

    expect(hook.ran).toBe(true);
    expect(hook.result).toBeNull();
    expect(hook.error).not.toBeNull();
    expect(String(hook.error)).toContain('ENOENT');
  }, TEST_TIMEOUT_MS);

  it('parseCompetitorOutput refuses a result with no boolean "acquired", or with an "error" field', () => {
    expect(parseCompetitorOutput('{"acquired":true}\n')).toEqual({ acquired: true });
    expect(parseCompetitorOutput('noise\n{"acquired":false,"held":"locked by another process"}\n'))
      .toEqual({ acquired: false, held: 'locked by another process' });
    expect(() => parseCompetitorOutput('')).toThrow();
    expect(() => parseCompetitorOutput('null')).toThrow('no result object');
    expect(() => parseCompetitorOutput('{}')).toThrow('boolean "acquired"');
    expect(() => parseCompetitorOutput('{"acquired":"false"}')).toThrow('boolean "acquired"');
    expect(() => parseCompetitorOutput('{"acquired":false,"error":"boom"}')).toThrow('reported an error');
  });
});
