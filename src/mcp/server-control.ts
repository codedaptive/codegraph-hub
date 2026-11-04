/**
 * Control of the machine server from outside it: find it, stop it, and ask it
 * to let go of one project. Behind `codegraph daemon [--stop]`, the launcher's
 * replace-an-older-server step (src/mcp/index.ts) and `codegraph index`.
 *
 * The server's authoritative record is `<state>/server.pid`
 * ({@link ServerLockInfo}); there is no separate registry. The lock says who the
 * server is, never that it is alive and never that it is CodeGraph: a SIGKILL'd
 * server leaves its record behind, and the OS reuses pids. So every action that
 * signals a process first proves the lock with the server's socket hello
 * ({@link probeServerIdentity}: the hello must name the lock's pid and version).
 * A pid that fails the proof is never signalled.
 *
 * Cross-platform by construction: files, sockets and `process.kill(pid,
 * signal)`, which behave consistently on macOS/Linux (real signals) and Windows
 * (mapped to TerminateProcess).
 */
import * as fs from 'fs';
import * as net from 'net';
import { getStateDirIdentity } from '../extensions/host/server/state-dir';
import {
  decodeServerLock,
  getServerPidPath,
  getServerSocketCandidates,
  probeServerIdentity,
  type ServerLockInfo,
} from './daemon-paths';
import { removeLockIfUnchanged, snapshotLock } from './lock-takeover';
import { isOlderRelease } from './version';
import { WORKER_START_SETTLE_MS } from '../worker-teardown';

/**
 * Is `pid` a live process? `kill(pid, 0)` sends no signal — it just probes:
 * ESRCH ⇒ dead, EPERM ⇒ alive but not ours (still alive). Same liveness check
 * the PPID watchdog (#277) and server lock arbitration use.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The record in `<state>/server.pid`, or null when there is none, it is
 * unreadable, or it names another state dir. The last is a copied state dir's
 * record (cp -r, rsync, a cloned VM disk): the server it names is the source's,
 * never this state dir's, and is never probed or signalled from here. "Another"
 * is judged by identity ({@link getStateDirIdentity}), not by path, so a record
 * written through one spelling of this directory is accepted through another.
 */
export function readServerLock(): ServerLockInfo | null {
  // Outside the try: an invalid CODEGRAPH_STATE_DIR (relative) throws
  // InvalidStateDirError to the caller; it must never read as "no server".
  const pidPath = getServerPidPath();
  let raw: string;
  try {
    raw = fs.readFileSync(pidPath, 'utf8');
  } catch {
    return null;
  }
  return judgeLock(raw);
}

/**
 * Whether `info` was written by a server of this state dir, not copied here
 * with another one's: its `stateId` is this directory's identity
 * ({@link getStateDirIdentity}), never a comparison of paths, so a record
 * written through one spelling of this directory (a macOS firmlink, a bind
 * mount) is this directory's through any other. A state dir that does not exist
 * has no identity, so no record names it. The one rule behind
 * {@link readServerLock}, {@link stopServer} and the launcher's copied-state
 * check (src/mcp/index.ts).
 */
export function namesThisStateDir(info: ServerLockInfo): boolean {
  return info.stateId === getStateDirIdentity();
}

/** Decode `raw` and drop a record that names another state dir. */
function judgeLock(raw: string): ServerLockInfo | null {
  const info = decodeServerLock(raw);
  return info !== null && namesThisStateDir(info) ? info : null;
}

/**
 * The server of this state dir, proven alive: the lock's pid is a live process
 * and its socket hello names that pid and the lock's version. Null when there
 * is no lock, the process is gone, or it does not answer as the server (a
 * reused pid, a server partway through shutdown).
 */
export async function probeServer(): Promise<ServerLockInfo | null> {
  const info = readServerLock();
  if (info === null || !isProcessAlive(info.pid)) return null;
  return await probeServerIdentity(info) ? info : null;
}

/**
 * What {@link stopServer} found:
 *   - `not-running`: no lock, or its process is gone (the next server start
 *     clears the leftover).
 *   - `stopped`: the server was signalled and exited.
 *   - `kept`: `onlyIfOlderThan` was given and the server is the same, a newer or
 *     an unknown release; it was not signalled.
 *   - `still-running`: signalled, but still alive after the wait. Never
 *     escalated to SIGKILL: the server holds open databases, and its builder holds the writer locks.
 *   - `unverified`: a live process holds the lock but its hello did not name the
 *     lock's pid and version. It is not signalled: it may be a reused pid.
 */
export type StopOutcome = 'not-running' | 'stopped' | 'kept' | 'still-running' | 'unverified';

/**
 * How long {@link stopServer} waits for a signalled server to exit. The
 * server's shutdown can wait up to {@link WORKER_START_SETTLE_MS} for a query
 * worker still starting up before it exits; the rest covers closing the
 * projects and the socket.
 */
const SERVER_STOP_WAIT_MS = WORKER_START_SETTLE_MS + 5_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(50);
  }
  return !isProcessAlive(pid);
}

/**
 * Stop the server of this state dir: verify its identity by socket hello, send
 * SIGTERM (its graceful shutdown), wait up to `graceMs` for the pid to go.
 *
 * `onlyIfOlderThan` makes it the launcher's replace step (#2335): the server is
 * stopped only when it runs a release older than that version
 * ({@link isOlderRelease}); one of the same, a newer or an unknown version is
 * `kept`, so two installs cannot take turns stopping each other's server.
 *
 * A stopped server removes its own lock and socket on a graceful exit; when it
 * could not (Windows, where SIGTERM is TerminateProcess), the sweep below removes
 * the lock and, on POSIX, the socket candidates, but only while the lock is still
 * the stopped record.
 */
export async function stopServer(
  opts: { onlyIfOlderThan?: string; graceMs?: number } = {},
): Promise<{ outcome: StopOutcome; pid?: number; version?: string }> {
  const pidPath = getServerPidPath();
  const snapshot = snapshotLock(pidPath);
  const info = snapshot === null ? null : judgeLock(snapshot.raw);
  if (snapshot === null || info === null) return { outcome: 'not-running' };
  const { pid, version } = info;
  if (!isProcessAlive(pid)) return { outcome: 'not-running', pid, version };
  // Never signal a process merely because it reuses a stale server pid: the
  // server's own hello is the identity proof (#1553).
  if (!await probeServerIdentity(info)) return { outcome: 'unverified', pid, version };
  if (opts.onlyIfOlderThan !== undefined && !isOlderRelease(version, opts.onlyIfOlderThan)) {
    return { outcome: 'kept', pid, version };
  }
  // The probe awaited I/O: act only on the record that was proven.
  const current = snapshotLock(pidPath);
  if (current === null || current.raw !== snapshot.raw) return { outcome: 'unverified', pid, version };

  try { process.kill(pid, 'SIGTERM'); } catch { /* raced to exit */ }
  if (!await waitForDeath(pid, opts.graceMs ?? SERVER_STOP_WAIT_MS)) {
    return { outcome: 'still-running', pid, version };
  }
  sweepStoppedServer(pidPath, snapshot.raw);
  return { outcome: 'stopped', pid, version };
}

/**
 * Remove what a stopped server left behind, when the lock is still the record
 * that was stopped. Sockets go BEFORE the lock, so no successor can take the
 * lock and bind a socket this sweep then removes; a lock that changed meanwhile
 * is a successor's and everything stays.
 */
function sweepStoppedServer(pidPath: string, stoppedRaw: string): void {
  try {
    const left = snapshotLock(pidPath);
    if (left === null || left.raw !== stoppedRaw) return;
    // POSIX sockets are real files; Windows named pipes vanish with the process.
    if (process.platform !== 'win32') {
      for (const candidate of getServerSocketCandidates()) {
        try { fs.unlinkSync(candidate); } catch { /* gone */ }
      }
    }
    removeLockIfUnchanged(pidPath, left);
  } catch {
    /* best effort: the next server start clears a stale lock itself */
  }
}

/**
 * How long {@link requestProjectRelease} waits for the server's reply. 20 s
 * because the server's release handler waits for every active tool call (of
 * any project, not only this one) to finish before it closes the project, and
 * only then answers.
 */
const RELEASE_TIMEOUT_MS = 20_000;

/**
 * Ask the running server to close the database it holds for `root` (an
 * absolute path) and to have its index builder drop its hold on it (the
 * builder's watcher and writer lock), so the caller can rebuild the index. The
 * server keeps serving every other project and reopens this one on its next
 * call, when the builder holds it again.
 *
 * Protocol (src/mcp/daemon.ts): connect, read the server's hello line, send a
 * client-hello `{codegraph_client:1, control:1, pid, hostPid: null}` carrying no `launchDir` (this is not a
 * session), then one JSON-RPC request
 * `{"jsonrpc":"2.0","id":"release","method":"codegraph/releaseProject","params":{"root":<root>}}`
 * and wait for the reply with that id.
 *
 *   - `no-server`: nothing answers on any candidate socket (or the lock's own).
 *   - `released`: the server replied with a result: neither it nor its builder holds anything for `root`.
 *   - `failed`: it answered something else, an error, or nothing in time. The
 *     caller must not rebuild under a server that may still hold the database.
 */
export async function requestProjectRelease(
  root: string,
  timeoutMs = RELEASE_TIMEOUT_MS,
): Promise<'released' | 'no-server' | 'failed'> {
  const lock = readServerLock();
  const candidates = [...new Set([...(lock ? [lock.socketPath] : []), ...getServerSocketCandidates()])]
    .filter((p) => p.length > 0);
  for (const socketPath of candidates) {
    const result = await releaseOverSocket(socketPath, root, timeoutMs);
    if (result !== 'no-server') return result;
  }
  return 'no-server';
}

/**
 * Is `message` (the first line a server socket sends) a CodeGraph server's hello? Protocol 1 and a
 * `codegraph` version string. The one check behind {@link requestProjectRelease} and the CLI's builder
 * route (src/extensions/host/builder/cli-route.ts); a caller that must know WHICH server also compares
 * `pid` and `codegraph` with the lock it proved.
 */
export function isServerHello(message: Record<string, unknown>): boolean {
  return message.protocol === 1 && typeof message.codegraph === 'string';
}

/**
 * The client hello of a control client, as one line: `{codegraph_client:1, control:1, pid, hostPid:null}`
 * with no `launchDir`. The server treats a hello with the `control` marker and no `launchDir` as a control
 * client (src/mcp/daemon.ts), not an agent session, and accepts the CLI's index writes from it; the
 * release request of {@link requestProjectRelease} is sent on the same hello.
 */
export function controlClientHelloLine(): string {
  return JSON.stringify({ codegraph_client: 1, control: 1, pid: process.pid, hostPid: null }) + '\n';
}

/** One {@link requestProjectRelease} attempt on one socket path. */
function releaseOverSocket(
  socketPath: string,
  root: string,
  timeoutMs: number,
): Promise<'released' | 'no-server' | 'failed'> {
  return new Promise((resolve) => {
    let connected = false;
    let sentRequest = false;
    let buffer = '';
    let done = false;
    const socket = net.createConnection(socketPath);
    const finish = (result: 'released' | 'no-server' | 'failed') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(connected ? 'failed' : 'no-server'), timeoutMs);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.on('connect', () => { connected = true; });
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { return finish('failed'); }
        if (!sentRequest) {
          // The first line is the server's hello; anything else is not our server.
          if (!isServerHello(message)) return finish('failed');
          sentRequest = true;
          socket.write(controlClientHelloLine());
          socket.write(JSON.stringify({
            jsonrpc: '2.0', id: 'release', method: 'codegraph/releaseProject', params: { root },
          }) + '\n');
          continue;
        }
        if (message.id !== 'release') continue; // a notification: not the reply
        const result = message.result as Record<string, unknown> | undefined;
        return finish(!message.error && result?.released === true ? 'released' : 'failed');
      }
    });
    socket.on('error', () => finish(connected ? 'failed' : 'no-server'));
    socket.on('close', () => finish(connected ? 'failed' : 'no-server'));
  });
}
