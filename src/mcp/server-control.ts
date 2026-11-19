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
 * ({@link probeServerHello}: the hello must name the lock's pid and version).
 * A pid that fails the proof is never signalled.
 *
 * Cross-platform by construction: files, sockets and `process.kill(pid,
 * signal)`, which behave consistently on macOS/Linux (real signals) and Windows
 * (mapped to TerminateProcess).
 */
import * as fs from 'fs';
import * as net from 'net';
import { getStateDirIdentity } from '../extensions/host/server/state-dir';
import { isJsonObject } from '../extensions/host/server/isJsonObject';
import {
  decodeServerLock,
  getServerPidPath,
  getServerSocketCandidates,
  probeServerHello,
  type ServerLockInfo,
} from './daemon-paths';
import { newDaemonChallenge } from './daemon-proof';
import { daemonAnswerProves } from './daemonAnswerProves';
import { daemonChallengeLine } from './daemonChallengeLine';
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

export type ServerStatus =
  | { state: 'running'; info: ServerLockInfo }
  | { state: 'busy'; info: ServerLockInfo }
  | { state: 'not-running' };

/**
 * Status of this state dir's server lock. A matching hello proves the server
 * is running. Busy is inconclusive, not identity proof: the lock names a live
 * pid and its socket accepts the connection but sends no bytes through the
 * hello timeout. No valid lock, a dead pid or a mismatched hello means
 * not-running.
 */
export async function probeServerStatus(): Promise<ServerStatus> {
  const info = readServerLock();
  if (info === null || !isProcessAlive(info.pid)) return { state: 'not-running' };
  switch (await probeServerHello(info)) {
    case 'match': return { state: 'running', info };
    case 'no-answer': return { state: 'busy', info };
    case 'mismatch': return { state: 'not-running' };
  }
}

/**
 * The server of this state dir, proven alive: the lock's pid is a live process
 * and its socket hello names that pid and the lock's version. Null when there
 * is no lock, the process is gone, or it does not answer as the server,
 * including an inconclusive silent connection.
 */
export async function probeServer(): Promise<ServerLockInfo | null> {
  const status = await probeServerStatus();
  return status.state === 'running' ? status.info : null;
}

/**
 * What {@link stopServer} found:
 *   - `not-running`: no readable, valid lock for this state dir, or its process
 *     is gone (the next server start clears a leftover lock).
 *   - `stopped`: SIGTERM was attempted and the pid is no longer alive.
 *   - `kept`: `onlyIfOlderThan` was given and the server is the same, a newer or
 *     an unknown release; it was not signalled.
 *   - `still-running`: SIGTERM was attempted, but the pid is still alive after the wait. Never
 *     escalated to SIGKILL: the server holds open databases, and its builder holds the writer locks.
 *   - `busy`: the lock names a live pid and its socket accepted the connection
 *     but sent no bytes through the hello timeout. Inconclusive, not identity
 *     proof; it was not signalled.
 *   - `unverified`: the lock names a live process, but the hello did not match,
 *     the socket failed, or the lock disappeared or changed during the probe.
 *     The process is not signalled: identity was not proven for the current lock.
 */
export type StopOutcome = 'not-running' | 'stopped' | 'kept' | 'still-running' | 'busy' | 'unverified';

/**
 * Grace for sessions, sockets and the engine to stop before stopping the builder.
 * The default covers the query pool's wait for workers still starting: exiting
 * during that startup can crash Windows, so it shares WORKER_START_SETTLE_MS.
 */
export function resolveServerStopGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CODEGRAPH_SERVER_STOP_GRACE_MS;
  if (raw === undefined || raw.trim() === '') return WORKER_START_SETTLE_MS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0
    ? Math.min(value, 120_000)
    : WORKER_START_SETTLE_MS;
}

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
 * SIGTERM, then wait for the pid to go. `graceMs` overrides the controller's
 * wait; by default it reads the controller's own environment for the server
 * grace and adds the builder's 5 s cap and a 2 s margin. The server may have a
 * different environment. Windows shutdown timing is untested for sm.14 (R-21).
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
  switch (await probeServerHello(info)) {
    case 'no-answer': return { outcome: 'busy', pid, version };
    case 'mismatch': return { outcome: 'unverified', pid, version };
    case 'match': break;
  }
  if (opts.onlyIfOlderThan !== undefined && !isOlderRelease(version, opts.onlyIfOlderThan)) {
    return { outcome: 'kept', pid, version };
  }
  // The probe awaited I/O: act only on the record that was proven.
  const current = snapshotLock(pidPath);
  if (current === null || current.raw !== snapshot.raw) return { outcome: 'unverified', pid, version };

  try { process.kill(pid, 'SIGTERM'); } catch { /* raced to exit */ }
  // Resolve at call time: grace + the builder's 5 s cap + 2 s margin (also
  // covering Windows' drain backstop). This controller reads its own env,
  // which may differ from the running server's; explicit callers keep theirs.
  const waitMs = opts.graceMs ?? (resolveServerStopGraceMs() + 5_000 + 2_000);
  if (!await waitForDeath(pid, waitMs)) {
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
 * Protocol (src/mcp/daemon.ts): connect, read the server's hello line, send only a challenge line
 * (src/mcp/daemon-proof.ts) and read the next line, which must be the server's proof for this socket path.
 * Only then send a client-hello `{codegraph_client:1, control:1, pid, hostPid: null}` carrying no
 * `launchDir` (this is not a session), then one JSON-RPC request
 * `{"jsonrpc":"2.0","id":"release","method":"codegraph/releaseProject","params":{"root":<root>}}`
 * and wait for the reply with that id. Each candidate socket is tried in turn until one is not `no-server`:
 * the first `failed` ends the search, because a socket that answered but did not prove itself may be a live
 * server holding the database (its key unreadable, its proof slow, or an older server without proofs).
 *
 *   - `no-server`: no candidate socket (the lock's own first) accepts a connection before it errors, closes
 *     or times out.
 *   - `released`: the server proved it runs as this user, and only then was sent the control hello and the
 *     release request, and replied with a result: neither it nor its builder holds anything for `root`.
 *   - `failed`: what connected sent a line that is not a server hello, or closed, errored or timed out before
 *     its hello; or after the hello it sent anything but a matching proof (another
 *     key or socket path, a null proof, another line, a line that is not a JSON object), or closed, errored or timed out
 *     before its proof; or it proved itself and then answered the release with an error, something else, or
 *     nothing in time. The caller must not rebuild under a server that may still hold the database.
 *
 * `onFailed`, when given, is called with the socket path of the `failed` attempt before `failed` is returned, so
 * the caller can name the socket in its refusal.
 */
export async function requestProjectRelease(
  root: string,
  timeoutMs = RELEASE_TIMEOUT_MS,
  onFailed?: (socketPath: string) => void,
): Promise<'released' | 'no-server' | 'failed'> {
  const lock = readServerLock();
  const candidates = [...new Set([...(lock ? [lock.socketPath] : []), ...getServerSocketCandidates()])]
    .filter((p) => p.length > 0);
  for (const socketPath of candidates) {
    const result = await releaseOverSocket(socketPath, root, timeoutMs);
    if (result === 'failed') onFailed?.(socketPath);
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
    let phase: 'hello' | 'proof' | 'open' = 'hello';
    const challenge = newDaemonChallenge();
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
    // A socket that never connected is 'no-server', and the next candidate is tried. Anything that connected
    // and then stops answering, before its hello, before its proof or before its release reply, is 'failed':
    // an unproven socket may still be a live server holding the database, so the caller must not rebuild.
    const unanswered = () => finish(connected ? 'failed' : 'no-server');
    const timer = setTimeout(unanswered, timeoutMs);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.on('connect', () => { connected = true; });
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const result = releaseStep(line);
        if (result) return finish(result);
      }
    });
    socket.on('error', unanswered);
    socket.on('close', unanswered);

    // One line read; the attempt's result once it has one.
    function releaseStep(line: string): 'released' | 'no-server' | 'failed' | undefined {
      // Every line of our server's protocol is a JSON object: anything else is not our server.
      let message: unknown;
      try { message = JSON.parse(line); } catch { return 'failed'; }
      if (!isJsonObject(message)) return 'failed';
      switch (phase) {
        case 'hello':
          // The first line is the server's hello; anything else is not our server.
          if (!isServerHello(message)) return 'failed';
          phase = 'proof';
          socket.write(daemonChallengeLine(challenge));
          return undefined;
        case 'proof':
          if (!daemonAnswerProves(challenge, socketPath, message.codegraph_proof)) return 'failed';
          phase = 'open';
          socket.write(controlClientHelloLine());
          socket.write(JSON.stringify({
            jsonrpc: '2.0', id: 'release', method: 'codegraph/releaseProject', params: { root },
          }) + '\n');
          return undefined;
        case 'open': {
          if (message.id !== 'release') return undefined; // a notification: not the reply
          const result = message.result as Record<string, unknown> | undefined;
          return !message.error && result?.released === true ? 'released' : 'failed';
        }
      }
    }
  });
}
