/**
 * Socket and lockfile paths of the machine server.
 *
 * There is ONE `codegraph serve --mcp` server per state dir (the user's
 * `~/.codegraph`, or `CODEGRAPH_STATE_DIR` for a development build; see
 * src/extensions/host/server/state-dir.ts), shared by every client on the
 * machine. The rendezvous between cooperating processes is three files in the
 * state dir:
 *
 *   - `server.sock` — Unix domain socket / named pipe the server listens on.
 *   - `server.pid` — atomic-create lockfile holding the server's identity record
 *     ({@link ServerLockInfo}: pid, version, bound socket path, start time and
 *     the state dir it serves, by path for display and by identity for judging).
 *   - `server.log` — the detached server's stdout/stderr.
 *
 * Nothing is keyed on a project root: the server answers for any project a
 * session names, so no path here depends on one.
 *
 * Special-case: Unix domain socket paths have a length limit that depends on
 * the OS and on the libuv inside the Node running the server. Measured on
 * Darwin 27.2 with Node 26 only: absolute paths of 100 to 253 bytes bind and
 * connect, and 254 bytes and more fail with EINVAL. Other systems and Node
 * versions are not measured and the limit may differ there, which is why no
 * per-OS number is used. So when `<state>/server.sock` is over
 * {@link POSIX_SOCKET_PATH_LIMIT} bytes we skip it, as a conservative margin and
 * not as the OS limit, and use a hash of the state dir's identity under
 * `os.tmpdir()`. The tmpdir candidate is never length-checked: it is always
 * listed, a too-long one fails its bind, and when no candidate binds the
 * SocketBindError from src/mcp/daemon.ts names it. The pidfile
 * always stays in the state dir (it doesn't have a length limit) — and acts as
 * the authoritative pointer to the socket path the server chose.
 *
 * Second special-case (#997, #974): some filesystems can't host an AF_UNIX node
 * AT ALL — ExFAT/FAT external volumes, certain network mounts, WSL2 DrvFs — so
 * `listen()` throws ENOTSUP/EACCES regardless of path length. We can't cheaply
 * tell those apart from a normal volume up front, so instead of guessing we
 * expose an ORDERED candidate list ({@link getServerSocketCandidates}): the
 * state-dir path first, then the deterministic tmpdir path (the only candidate
 * when the state-dir path is over the limit). The server binds the first that works (relocating past a capability
 * error); the proxy connects the first that answers. Both walk the SAME list, so
 * they still converge on whichever the server bound with zero coordination.
 */

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { getStateDir, getStateDirIdentity } from '../extensions/host/server/state-dir';

/**
 * Length, in bytes (what the kernel counts), above which the state-dir socket is
 * skipped. A conservative margin under the OS limit (measured on Darwin 27.2 with
 * Node 26 only; see the file header), not the limit itself. Never applied to the tmpdir candidate. Exported so the
 * bind failure message (src/mcp/daemon.ts) can name the same number.
 */
export const POSIX_SOCKET_PATH_LIMIT = 100;

/**
 * Short stable identifier for the state dir — used in tmpdir/pipe names. The
 * key is a rendezvous, so it hashes the state dir's identity
 * ({@link getStateDirIdentity}: `dev:ino`, or the lower-cased realpath on
 * Windows), never a path: one directory reached by two spellings (macOS's
 * `/Users/...` and `/System/Volumes/Data/Users/...` firmlink, a bind mount) is
 * one name. Distinct state dirs hash to distinct names; a 64-bit hash makes
 * collisions negligible.
 */
function stateIdHash(stateId: string): string {
  // `crypto` is the slowest builtin to load, and every CLI command loads this file.
  const { createHash } = require('crypto') as typeof import('crypto');
  return createHash('sha256').update(stateId).digest('hex').slice(0, 16);
}

/**
 * Ordered socket / named-pipe path candidates the server should try to bind (and
 * the proxy should try to connect), most-preferred first. Deterministic given the
 * state dir, so independent processes converge without coordination — even when
 * the preferred candidate is unusable and both fall through to the same fallback.
 *
 *   - Windows: a single named pipe keyed on the hash of the state dir's identity
 *     (lives in the kernel pipe namespace, not on the state dir's FS, so neither
 *     the length nor the ExFAT hazard applies).
 *   - Short state-dir path: `[ <state>/server.sock , <tmpdir>/codegraph-server-<hash>.sock ]`
 *     — try the state dir first, fall back to tmpdir if its FS can't host a
 *     socket (#997).
 *   - Long state-dir path (over {@link POSIX_SOCKET_PATH_LIMIT}): `[ <tmpdir>/... ]`
 *     only — the state-dir socket is skipped, not tried, so we go straight to tmpdir.
 *
 * The tmpdir candidate is listed whatever its length. A SocketBindError, naming
 * each path, its byte length and its error code, is thrown only when every
 * candidate fails with a non-conflict error (say a tmpdir path past the OS limit
 * and a state dir that cannot host a socket). `Daemon.start` rethrows it after
 * releasing the lock, the serve command exits 1, and the launchers serve
 * in-process. A racing EADDRINUSE is rethrown raw instead.
 *
 * The tmpdir socket and the pipe are the same for every spelling of one physical
 * state dir (they hash its identity). The state-dir candidate is that dir's own
 * `server.sock` and is spelled with {@link getStateDir}'s path, so two spellings
 * of one dir name the one socket file twice; whether it is listed at all depends
 * on the spelling's length. A caller that must find a server bound by another
 * spelling therefore also tries the lock's `socketPath` (the bound socket,
 * whatever its spelling; see src/mcp/index.ts and server-control.ts).
 *
 * Empty while the state dir does not exist: it has no identity yet and no
 * server can be bound for it, so a probe finds none. The caller that creates
 * the server calls `ensureStateDir()` first (src/mcp/daemon.ts, the launcher's
 * spawn), after which the list is never empty.
 */
export function getServerSocketCandidates(): string[] {
  const state = getStateDir();
  const stateId = getStateDirIdentity();
  if (stateId === null) return [];
  const hash = stateIdHash(stateId);
  if (process.platform === 'win32') {
    return [`\\\\.\\pipe\\codegraph-server-${hash}`];
  }
  const inState = path.join(state, 'server.sock');
  const tmp = path.join(os.tmpdir(), `codegraph-server-${hash}.sock`);
  if (Buffer.byteLength(inState) > POSIX_SOCKET_PATH_LIMIT) return [tmp];
  return [inState, tmp];
}

/**
 * The PREFERRED (primary) socket path — candidate 0. Use this only where a
 * single representative path is wanted (the lockfile's informational
 * `socketPath` field, status display). For binding/connecting, walk the full
 * {@link getServerSocketCandidates} list — the server may bind a fallback when
 * candidate 0 is unusable. Throws when the state dir does not exist yet (only a
 * caller that has not called `ensureStateDir()` first can see that).
 */
export function getServerSocketPath(): string {
  const first = getServerSocketCandidates()[0];
  if (first === undefined) throw new Error(`The state dir ${getStateDir()} does not exist; no server socket path yet.`);
  return first;
}

/** Absolute path to the server's pid lockfile: `<state>/server.pid`. */
export function getServerPidPath(): string {
  return path.join(getStateDir(), 'server.pid');
}

/** Absolute path to the detached server's log: `<state>/server.log`. */
export function getServerLogPath(): string {
  return path.join(getStateDir(), 'server.log');
}

/**
 * Structured contents of the pid lockfile. `stateId` is the identity of the
 * state dir the writing server serves ({@link getStateDirIdentity}, taken after
 * `ensureStateDir()`): a state dir copied with cp -r or rsync carries the
 * source's `server.pid` along, and a record naming another identity is the
 * copy's foreign record, never this state dir's server
 * (src/mcp/server-control.ts readServerLock drops it). A cloned disk image can
 * keep `dev:ino`, so the identity does not prove who serves: the pid's liveness
 * and the socket hello ({@link probeServerIdentity}) still decide that. Identity,
 * not path: one directory reached by two spellings is one state dir. `stateDir`
 * is the path as the writer spelled it, for display only and never compared.
 */
export interface ServerLockInfo {
  pid: number;
  version: string;
  socketPath: string;
  startedAt: number;
  stateDir: string;
  stateId: string;
}

/**
 * Verify that the process named by a lockfile is the CodeGraph server serving
 * its socket. A bare PID liveness probe is insufficient because OSes reuse PIDs
 * after an OOM/SIGKILL (#1553): the server's immediate hello must name this pid
 * and exactly this version. No version string is a wildcard: the server writes
 * the lock and the hello from one value, even the "0.0.0-unknown" fallback of
 * src/mcp/version.ts, so equality covers it.
 */
export function probeServerIdentity(info: ServerLockInfo, timeoutMs = 1_000): Promise<boolean> {
  if (
    !Number.isInteger(info.pid) || info.pid <= 0 ||
    typeof info.socketPath !== 'string' || info.socketPath.length === 0
  ) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let socket: net.Socket;
    let buffer = '';
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    try {
      socket = net.createConnection(info.socketPath);
    } catch {
      clearTimeout(timer);
      resolve(false);
      return;
    }
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      // Bounds the read: a server hello is a few hundred bytes at most; more is not our server.
      if (buffer.length > 4096) return finish(false);
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const hello = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        finish(
          hello.protocol === 1 &&
          hello.pid === info.pid &&
          hello.codegraph === info.version
        );
      } catch {
        finish(false);
      }
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}

/**
 * Serialize a {@link ServerLockInfo} for writing to the pidfile. JSON for
 * human readability — operators occasionally `cat` this when debugging.
 */
export function encodeServerLock(info: ServerLockInfo): string {
  return JSON.stringify(info, null, 2) + '\n';
}

/**
 * Parse a pidfile body. Null for anything that is not a complete record (an
 * empty or corrupt leftover, or a record missing a field): the caller sees "no
 * server here" (a record without `stateId` included: it names no identity to
 * judge by). Only the six {@link ServerLockInfo} fields are kept.
 */
export function decodeServerLock(raw: string): ServerLockInfo | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed.pid === 'number' &&
      typeof parsed.version === 'string' &&
      typeof parsed.socketPath === 'string' &&
      typeof parsed.startedAt === 'number' &&
      typeof parsed.stateDir === 'string' &&
      typeof parsed.stateId === 'string' &&
      parsed.stateId.length > 0
    ) {
      return {
        pid: parsed.pid,
        version: parsed.version,
        socketPath: parsed.socketPath,
        startedAt: parsed.startedAt,
        stateDir: parsed.stateDir,
        stateId: parsed.stateId,
      };
    }
  } catch {
    // Not JSON: no record.
  }
  return null;
}
