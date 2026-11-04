/**
 * The machine server: one CodeGraph MCP server per state directory.
 *
 * One detached `codegraph serve --mcp` process per computer (per user state
 * directory, see `getStateDir()`), accepting N concurrent MCP clients over a
 * Unix-domain socket (or named pipe on Windows). Each incoming connection gets
 * its own {@link MCPSession}; all sessions share a single {@link MCPEngine}, so
 * every repository any agent asks about is served by one process: one query
 * worker pool and one SQLite connection per open project. The server is not rooted anywhere: it holds no default project, and
 * every tool call names its own `projectPath` (the session's repo anchor decides
 * which repositories that session may ask about).
 *
 * The server only reads. Every index write (cold builds, seeding a worktree's
 * index, syncs, the file watchers) is done by the index builder, one child
 * process of the server (src/extensions/host/builder/): the server starts it with
 * itself, restarts it when it dies, never idles it out, and stops it when it
 * stops. A builder that loses its server exits with the connection to it.
 *
 * Lifecycle (see also `./index.ts` and `./proxy.ts`):
 *   - The server is spawned **detached** (its own session/process group, stdio
 *     decoupled, cwd = the state directory) by the first launcher that finds no
 *     server running. It is NOT a child of any MCP host, so closing one terminal
 *     / Ctrl-C'ing one session can't take it down and sever the others. That's
 *     why this process has no PPID watchdog: it deliberately outlives every
 *     individual client.
 *   - Every MCP host talks to the server through a thin `proxy` process (the
 *     thing the host actually spawned). The proxy keeps the #277 PPID watchdog,
 *     so a SIGKILL'd host still reaps its proxy promptly; the proxy's socket
 *     close then drops that client's session.
 *   - The server never exits because it is idle: it is a standing service, and
 *     what is left when the last client leaves (open projects) is bounded by
 *     the project idle close in `tools.ts`. It exits on SIGTERM/SIGINT
 *     (`codegraph daemon --stop`) or when the install it runs from is upgraded or
 *     removed ({@link installChangedReason}).
 *
 * What this file owns:
 *   - Listening on the server socket and spawning per-connection sessions.
 *   - The handshake "hello" line that lets a proxy verify it found a
 *     same-version server before piping any JSON-RPC through it, and the
 *     optional client hello carrying the client's pids and launch directory.
 *   - The lockfile (`<state>/server.pid`) competing servers arbitrate
 *     against — an atomic hard-link create of a complete record; an O_EXCL create
 *     where links are unsupported. Cleanup on exit.
 *   - The dead-client liveness sweep and the install-changed exit.
 *   - Graceful shutdown on SIGTERM/SIGINT.
 *
 * What this file does NOT own:
 *   - The proxy side (`./proxy.ts`).
 *   - The decision of *whether* to run as the server at all — that's `MCPServer`.
 *   - The MCP protocol state machine — that's `./session.ts`.
 *   - The repo anchor and the call guard — `src/extensions/host/server/repo-anchor.ts`.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { MCPEngine } from './engine';
import { MCPSession } from './session';
import { SocketTransport } from './transport';
import {
  ServerLockInfo,
  decodeServerLock,
  encodeServerLock,
  POSIX_SOCKET_PATH_LIMIT,
  getServerPidPath,
  getServerSocketCandidates,
  getServerSocketPath,
} from './daemon-paths';
import { CodeGraphPackageJsonPath, CodeGraphPackageVersion } from './version';
import { isProcessAlive } from './server-control';
import { removeLockIfUnchanged, snapshotLock, writeExclusiveTemp } from './lock-takeover';
import { ensureStateDir, getStateDir, getStateDirIdentity } from '../extensions/host/server/state-dir';
import { resolveRepoAnchor, type RepoAnchor } from '../extensions/host/server/repo-anchor';
import { MAX_FOCUS_ENTRIES, parseToolAllowlist, sessionFocusEntries } from '../extensions/host/server/session-scope';
import { BuilderClient } from '../extensions/host/builder/client';

/**
 * Windows-only shutdown backstop. On Windows, calling `process.exit()` while a
 * recursive `fs.watch` handle is still tearing down aborts the process with a
 * libuv `UV_HANDLE_CLOSING` assertion (`0xC0000409`) — reproducible whenever the
 * watched tree contains a nested repo (submodule / embedded clone), since that's
 * what keeps a watch active at shutdown. The fix is to let the event loop drain
 * so libuv finishes closing those handles, then exit naturally; this timer only
 * force-exits if some unexpected handle keeps the loop alive past the grace
 * window. Kept short so shutdown stays snappy in that fallback. See
 * `finalizeDaemonExit`.
 */
const DAEMON_SHUTDOWN_BACKSTOP_MS = 2_000;

/**
 * Finalize daemon shutdown. On POSIX, exit immediately — it's clean and fast.
 * On Windows, do NOT force an exit while watchers may still be closing (that
 * trips the libuv assertion above); instead mark success and let the loop drain
 * to a natural exit, with an UNREF'd backstop that force-exits only if a stray
 * handle would otherwise hang shutdown. Pure and platform-injected so both
 * branches are unit-testable off-Windows. Returns the backstop timer (Windows)
 * so callers/tests can clear it.
 */
export function finalizeDaemonExit(
  platform: NodeJS.Platform,
  exit: (code: number) => void,
): NodeJS.Timeout | null {
  if (platform === 'win32') {
    process.exitCode = 0;
    const backstop = setTimeout(() => exit(0), DAEMON_SHUTDOWN_BACKSTOP_MS);
    // Unref so it never keeps the loop alive: a natural drain (watchers closed,
    // nothing else pending) exits before it fires; it only fires when some other
    // handle is keeping the loop running, which is exactly when we need it.
    backstop.unref?.();
    return backstop;
  }
  exit(0);
  return null;
}

/** How often the daemon sweeps connected clients for a dead peer process (#692). */
const DEFAULT_CLIENT_SWEEP_MS = 30_000;

/** How often the daemon checks that the install it runs from is still in place (#2335). */
const DEFAULT_INSTALL_CHECK_MS = 30_000;

/**
 * Why the install this daemon was started from no longer matches it, or null
 * while it still does. An upgrade replaces or deletes the package directory
 * under a running daemon (npm reinstalling the package, the launcher pruning
 * an old bundle), and everything the daemon loads lazily from there afterwards
 * fails — grammars among them, so every file its builder's watcher re-indexed came out
 * empty (#2335). Such a daemon should make way for one started from the
 * current install. Any other read failure, or a package.json caught mid-write,
 * answers null: the next check looks again. Exported for testing.
 */
export function installChangedReason(packageJsonPath: string, runningVersion: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(packageJsonPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? `Install removed (${packageJsonPath} is gone)` : null;
  }
  let version: unknown;
  try {
    version = (JSON.parse(raw) as { version?: unknown } | null)?.version;
  } catch {
    return null;
  }
  return typeof version === 'string' && version !== runningVersion
    ? `Install replaced by v${version} (this daemon is v${runningVersion})`
    : null;
}

/** How long the server waits for the optional client-hello before proceeding without it. */
const CLIENT_HELLO_TIMEOUT_MS = 3_000;

/**
 * Bytes/parse-window for an oversized hello line — bounded against a malicious
 * peer. Sized for a client hello that carries a launch directory (a path can be
 * a few KiB on a deep tree, and JSON escaping can multiply it), the session's
 * focus directories and its tool allowlist, and also bounds the proxy's read of
 * the server hello.
 */
const MAX_HELLO_LINE_BYTES = 65536;

/**
 * Wire format for the one-shot hello line the server emits on every new
 * connection. Versioned with the package's own semver. A proxy never pipes
 * through another version: an older server is replaced by the launcher; a newer
 * one leaves that session in-process.
 */
export interface DaemonHello {
  codegraph: string; // package version (must match the proxy's own version)
  pid: number;       // server pid (informational; for `ps` debugging)
  socketPath: string; // echoed back so the proxy can log it
  protocol: 1;       // bump if the hello shape changes
}

/**
 * Optional reverse-handshake line a proxy sends right after it verifies the
 * server hello. It carries the proxy's own pids, so the server can reap the
 * client if its process dies WITHOUT the socket ever signalling close (the
 * Windows named-pipe hazard behind #692), and the directory the session was
 * launched in, which fixes the session's repo anchor, and the session's own
 * focus and tool allowlist (the server's flags and environment belong to
 * whichever client started it, so neither can stand in for a later client's).
 * Entirely optional and fail-safe: a legacy client that never sends it falls
 * back to the socket-close lifecycle, and one that sends no `tools` gets the
 * server process's own CODEGRAPH_MCP_TOOLS. The codegraph CLI's own connections
 * (`requestProjectRelease`'s one-shot release request, and the index writes it
 * routes through `codegraph/indexWrite`) send a client hello without a
 * `launchDir`, `focus` or `tools`, so they have no anchor; a session without a
 * `launchDir` answers a call without a projectPath with the missing-argument
 * text, as every session does, and a call that names a path with guidance to
 * restart it. A hello that carries `control: 1` and no `launchDir` key at all is
 * what makes the connection a control client (`ClientPeers.control` true and
 * `hasLaunchDir` false), the only kind that may send `codegraph/indexWrite`:
 * the role is granted on that positive marker, never on a missing field. The
 * `codegraph_client` marker is what tells it apart from the client's first
 * JSON-RPC message.
 */
export interface DaemonClientHello {
  codegraph_client: 1;
  pid: number;             // the proxy process's own pid
  hostPid: number | null;  // the MCP host pid (past any launcher shim), if known
  /** Present (1) only in the codegraph CLI's own control connections: see ClientPeers.control. */
  control?: 1;
  /** Absolute directory the session was launched in (`-p` or the cwd); fixes the session's repo anchor. */
  launchDir?: string;
  /**
   * The session's `--focus` directories, normalised and relative to the
   * repository root (`normaliseFocusArgs`); `[]` for a session with none. The
   * server keeps them as repo-relative entries (`sessionFocusEntries`, which
   * drops a bad one) and resolves them per call against the worktree the call
   * lands in.
   */
  focus?: string[];
  /**
   * The client process's raw CODEGRAPH_MCP_TOOLS, `''` when unset. Always sent
   * by a proxy's session hello, even when empty, so a client with no allowlist
   * never inherits the server process's.
   */
  tools?: string;
}

/**
 * What the server learns about one client from its client hello; the pids and
 * launch directory are null without one. `focus` and `tools` are ABSENT (not
 * null) when the hello did not carry them, which is how the server tells a
 * session that was told "no allowlist" (`tools: ''`) from one never told.
 */
export interface ClientPeers {
  pid: number | null;
  hostPid: number | null;
  launchDir: string | null;
  /**
   * Whether the hello carried a `launchDir` key at all (even an unusable one, which `launchDir` reads as
   * null): an agent's session always sends one, the codegraph CLI's control connection never does. False
   * for a client with no hello.
   */
  hasLaunchDir: boolean;
  /**
   * Whether the hello carried `control: 1`, the codegraph CLI's marker for its control connections (false
   * for a client with no hello). A hello with it and no `launchDir` key makes the connection the CLI's
   * control client, the only kind that may send `codegraph/indexWrite`: the role is granted on this marker
   * being present, not on `launchDir` being absent.
   */
  control: boolean;
  focus?: string[];
  tools?: string;
}

const NO_PEERS: ClientPeers = { pid: null, hostPid: null, launchDir: null, hasLaunchDir: false, control: false };

export interface DaemonStartResult {
  /** Always-non-null for a successfully-started server. */
  socketPath: string;
  /** Lockfile contents as written. */
  lock: ServerLockInfo;
}

/**
 * Bind the server's socket at `socketPath` and resolve once it listens, after clearing a stale socket left by
 * a SIGKILL'd previous server (the caller holds the server lock, so no live server owns it; without the
 * unlink `listen` would wedge on EADDRINUSE).
 *
 * POSIX: the socket is created under umask 0077, so it is owner-only from the moment it exists. A chmod
 * after `listen` alone leaves a window in which a connection made under a permissive umask (a state dir that
 * already exists with mode 0755, or the tmpdir fallback) is accepted by a server that now carries index
 * writes for a control client. `listen` binds a path synchronously, so the umask covers exactly the bind; it
 * is put back before this returns, also when `listen` throws. The chmod after listening stays as the
 * belt to that: a bind that ignores the umask (some filesystems) still ends owner-only.
 */
export function bindServerSocket(socketPath: string, onConnection: (socket: net.Socket) => void): Promise<net.Server> {
  return new Promise<net.Server>((resolve, reject) => {
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(socketPath); } catch { /* not-exists is fine */ }
    }
    const server = net.createServer(onConnection);
    server.once('error', reject);
    const priorUmask = process.platform === 'win32' ? null : process.umask(0o077);
    try {
      server.listen(socketPath, () => {
        if (process.platform !== 'win32') {
          try { fs.chmodSync(socketPath, 0o600); } catch { /* best-effort */ }
        }
        resolve(server);
      });
    } finally {
      if (priorUmask !== null) process.umask(priorUmask);
    }
  });
}

/**
 * Run as the machine server of this state directory. Resolves once the socket
 * is listening. The Daemon owns the socket, the engine, and the lockfile until
 * `stop()` is called or it exits on signal / install change.
 *
 * Race-safe: callers must first call `tryAcquireDaemonLock()` and only
 * construct a Daemon if they got the lock (`kind: 'acquired'`). The atomic
 * create/link inside the acquire helper elects one candidate; the lock record
 * is refreshed against an exact snapshot after the bind.
 */
export class Daemon {
  private server: net.Server | null = null;
  // Includes sockets waiting for the optional client hello, before a session
  // exists. server.close() waits for these too, so stop must destroy them.
  private acceptedSockets = new Set<net.Socket>();
  private clients = new Set<MCPSession>();
  /** Per-client peer pids from the optional client-hello, for the liveness sweep. */
  private clientPeers = new Map<MCPSession, ClientPeers>();
  private clientSweepTimer: NodeJS.Timeout | null = null;
  private installCheckTimer: NodeJS.Timeout | null = null;
  private engine: MCPEngine;
  // The index builder: a child of this process that does every index write
  // (cold builds, seeds, syncs, the watchers) for the engine's read-only
  // projects. It lives as long as the server does and has no idle exit of its
  // own; this process restarts it if it dies and stops it after the engine.
  private builder: BuilderClient;
  private stopping = false;
  private socketPath: string;
  private pidPath: string;

  constructor() {
    this.socketPath = getServerSocketPath();
    this.pidPath = getServerPidPath();
    this.builder = BuilderClient.start({
      onLog: (line) => process.stderr.write(`[CodeGraph daemon] ${line}\n`),
    });
    // The server serves many concurrent clients on one event loop, so off-load
    // read-tool dispatch to a worker pool — otherwise concurrent explores
    // serialize and starve the MCP transport (clients time out). Read tools run
    // on a worker pool; `CODEGRAPH_QUERY_POOL_SIZE=0` disables it. The engine is
    // rootless: a project is opened when a tool call names it, or, with
    // `openPinned`, when the registry pins it with an index: at start, and after
    // each housekeeping pass (with CODEGRAPH_HOUSEKEEPING_INTERVAL_MS=0 a later
    // pin is picked up at the next server start only).
    this.engine = new MCPEngine({ queryPool: true, builder: this.builder, openPinned: true });
  }

  /**
   * Bind the socket, refresh the ownership record, and register signal
   * handlers. The promise resolves once the server is listening — the server
   * then sticks around until a signal or an install change.
   */
  async start(): Promise<DaemonStartResult> {
    let initialLockContents: string;
    try {
      initialLockContents = fs.readFileSync(this.pidPath, 'utf8');
      if (decodeServerLock(initialLockContents)?.pid !== process.pid) {
        throw new Error('server lock belongs to another process');
      }
    } catch {
      throw new Error('Lost server lock ownership before startup.');
    }

    // Walk the ordered socket candidates and bind the first that works. The
    // state-dir path comes first; the deterministic tmpdir path is the fallback
    // for a filesystem that can't host an AF_UNIX node at all (ExFAT/FAT external
    // volumes, some network mounts, WSL2 DrvFs → ENOTSUP/EACCES; #997, #974). The
    // `listen` closure clears a stale socket (left by a SIGKILL'd previous server)
    // before each attempt — safe because we hold the lockfile, so no live server
    // owns it; without it `listen` would wedge on EADDRINUSE.
    const candidates = getServerSocketCandidates();
    const listen = (socketPath: string): Promise<net.Server> =>
      bindServerSocket(socketPath, (socket) => this.handleConnection(socket));

    // The state-dir socket is left off the candidate list when its path is over
    // POSIX_SOCKET_PATH_LIMIT (a conservative margin, not the OS limit; see
    // daemon-paths.ts). It is passed on as `skipped` so the failure message below
    // can say it was never tried. An empty list means the state dir is gone, and
    // there is nothing to report as skipped. Windows has a single pipe candidate.
    const stateSocket = path.join(getStateDir(), 'server.sock');
    const skipped =
      process.platform !== 'win32' && candidates.length > 0 && !candidates.includes(stateSocket)
        ? [{
            socketPath: stateSocket,
            reason: `longer than the ${POSIX_SOCKET_PATH_LIMIT}-byte state-dir limit`,
          }]
        : [];

    let bound: { server: net.Server; socketPath: string };
    try {
      bound = await bindFirstUsableSocket(candidates, listen, {
        onRelocate: (from, to, code) =>
          process.stderr.write(
            `[CodeGraph daemon] Socket ${from} unusable (${code}); relocating to ${to}.\n`
          ),
        skipped,
      });
    } catch (err) {
      // Every candidate failed with a non-conflict error (a SocketBindError naming
      // each one), or a racing EADDRINUSE (raw). We already hold the
      // lockfile `tryAcquireDaemonLock` wrote; release it and any partial sockets
      // so the NEXT launcher doesn't spin respawning us on a stale lock pointing
      // at our now-dying pid. Then re-throw so the caller (the bin's try/catch)
      // prints the message (after a `Failed to start server:` prefix) and exits this
      // detached server with status 1, and every launcher serves its session
      // in-process.
      this.cleanupLockfile();
      if (process.platform !== 'win32') {
        for (const candidate of candidates) {
          try { fs.unlinkSync(candidate); } catch { /* may not exist */ }
        }
      }
      throw err;
    }

    this.server = bound.server;
    // Adopt the path we ACTUALLY bound — it may be a tmpdir fallback past an
    // unusable state-dir location. Everything downstream (lockfile, chmod,
    // cleanup, status) keys off this real path, not the preferred guess.
    this.socketPath = bound.socketPath;

    const lock: ServerLockInfo = {
      pid: process.pid,
      version: CodeGraphPackageVersion,
      socketPath: this.socketPath,
      startedAt: Date.now(),
      stateDir: getStateDir(),
      stateId: requireStateDirIdentity(),
    };

    // Refresh the lock on every successful bind, not only relocation: the exact
    // snapshot compare prevents overwriting a replacement record.
    try {
      refreshDaemonLock(this.pidPath, initialLockContents, lock);
    } catch (err) {
      try { bound.server.close(); } catch { /* best-effort */ }
      this.cleanupLockfile();
      throw err;
    }

    process.stderr.write(
      `[CodeGraph daemon] Listening on ${this.socketPath} (pid ${process.pid}, v${CodeGraphPackageVersion}).\n`
    );

    this.startLivenessTimers();

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));

    return { socketPath: this.socketPath, lock };
  }

  /** Currently-connected client count. Exposed for tests / status output. */
  getClientCount(): number {
    return this.clients.size;
  }

  /** The socket path the server is (or will be) listening on. */
  getSocketPath(): string {
    return this.socketPath;
  }

  /** Graceful shutdown: close all sessions, the engine, and clean up the lock. */
  async stop(reason: string = 'stop'): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.clientSweepTimer) {
      clearInterval(this.clientSweepTimer);
      this.clientSweepTimer = null;
    }
    if (this.installCheckTimer) {
      clearInterval(this.installCheckTimer);
      this.installCheckTimer = null;
    }
    process.stderr.write(`[CodeGraph daemon] Shutting down (${reason}; clients=${this.clients.size}).\n`);
    for (const session of [...this.clients]) {
      try { session.stop(); } catch { /* best-effort */ }
    }
    this.clients.clear();
    for (const socket of this.acceptedSockets) socket.destroy();
    this.acceptedSockets.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    // The engine first (it tells the builder to let go of each project it
    // holds), then the builder itself.
    await this.engine.stop();
    await this.builder.stop();
    this.cleanupLockfile();
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.socketPath); } catch { /* may already be gone */ }
    }
    // POSIX exits here; Windows drains first (builder.stop() above waited for
    // the builder's file watchers to close with its exit, and exiting
    // mid-teardown aborts the process). See
    // finalizeDaemonExit / DAEMON_SHUTDOWN_BACKSTOP_MS.
    finalizeDaemonExit(process.platform, (code) => process.exit(code));
  }

  private handleConnection(socket: net.Socket): void {
    if (this.stopping) { socket.destroy(); return; }
    this.acceptedSockets.add(socket);
    socket.once('close', () => this.acceptedSockets.delete(socket));
    // Hello first so the proxy can verify versions before piping any
    // application bytes. The proxy reads exactly one line, then forwards.
    const hello: DaemonHello = {
      codegraph: CodeGraphPackageVersion,
      pid: process.pid,
      socketPath: this.socketPath,
      protocol: 1,
    };
    socket.write(JSON.stringify(hello) + '\n');

    // Read the optional client-hello (proxy → server) to learn the client's
    // peer pids and launch directory, then hand the socket to the session.
    // Fail-safe: any problem — timeout, a non-hello first line, an early close —
    // yields null peers and we fall back to the socket-close lifecycle (#692);
    // the session then has no anchor.
    void readClientHello(socket).then(async (peers) => {
      if (this.stopping || socket.destroyed) { socket.destroy(); return; }
      // The socket is paused by readClientHello until the transport starts, so
      // the anchor's git lookups cannot cost the client's first message.
      let anchor: RepoAnchor | null = null;
      if (peers.launchDir !== null) {
        try {
          anchor = await resolveRepoAnchor(peers.launchDir);
        } catch (err) {
          process.stderr.write(
            `[CodeGraph daemon] Could not resolve the repo anchor of ${peers.launchDir}: ${err instanceof Error ? err.message : String(err)}\n`
          );
        }
        if (this.stopping || socket.destroyed) { socket.destroy(); return; }
      }
      const transport = new SocketTransport(socket);
      // The session's own scope, from its hello: its repo-relative focus entries
      // (resolved per call, so they hold in every worktree of the repository), and
      // the client's allowlist (undefined when the hello carried none: a legacy
      // client, which falls back to this process's CODEGRAPH_MCP_TOOLS).
      const session = new MCPSession(transport, this.engine, {
        anchor,
        focus: sessionFocusEntries(peers.focus),
        toolAllowlist: peers.tools === undefined ? undefined : parseToolAllowlist(peers.tools),
        // The codegraph CLI's control connection: a client hello (numeric pid) with the `control: 1` marker
        // and no launchDir key.
        controlClient: peers.pid !== null && peers.control && !peers.hasLaunchDir,
      });
      transport.onClose(() => this.dropClient(session));
      this.clients.add(session);
      this.clientPeers.set(session, peers);
      session.start();
    });
  }

  /**
   * Forget a client and let go of the index leases it holds. Runs on the peer's close and on the reaper's
   * stop of a dead peer; `SocketTransport.stop` skips close handlers, so the reaper path needs this call.
   * The server's own stop clears its clients without it: the builder releases every fence when it stops.
   */
  private dropClient(session: MCPSession): void {
    if (!this.clients.delete(session)) return;
    this.clientPeers.delete(session);
    session.releaseLeases();
  }

  /**
   * Defense-in-depth against a client counted but gone (#692), for the case
   * where a socket close is never delivered. The **liveness sweep** drops any
   * client whose peer process has died (per the client-hello pids). The server
   * has no idle exit, so a phantom client costs only its session object; the
   * sweep keeps even that bounded. Also arms the install check. Both timers are
   * unref'd — the listening server keeps the loop alive, and neither should
   * hold it open on its own.
   */
  private startLivenessTimers(): void {
    const sweepMs = resolveClientSweepMs();
    if (sweepMs > 0) {
      this.clientSweepTimer = setInterval(() => this.reapDeadClients(isProcessAlive), sweepMs);
      this.clientSweepTimer.unref?.();
    }
    // An install whose version could not be read at startup has nothing to
    // compare against; leave that server alone.
    const installMs = resolveInstallCheckMs();
    if (installMs > 0 && CodeGraphPackageVersion !== '0.0.0-unknown') {
      this.installCheckTimer = setInterval(() => { this.checkInstall(); }, installMs);
      this.installCheckTimer.unref?.();
    }
  }

  /**
   * Exit once the install this server runs from has been upgraded or removed
   * (#2335; see {@link installChangedReason}). Its clients' proxies fall back
   * and reconnect, and the next launch starts a server from the current
   * install. Returns whether the server is exiting. The check is injected for
   * tests; the timer passes the real one.
   */
  checkInstall(
    changed: () => string | null = () => installChangedReason(CodeGraphPackageJsonPath, CodeGraphPackageVersion),
  ): boolean {
    if (this.stopping) return false;
    const reason = changed();
    if (!reason) return false;
    process.stderr.write(`[CodeGraph daemon] ${reason}; exiting so the next session starts a server from the current install.\n`);
    void this.stop('install changed');
    return true;
  }

  /**
   * Drop every connected client whose peer process is gone. Returns the count
   * reaped. `isAlive` is injected for testing. Clients with unknown pids (no
   * client-hello) are skipped — they rely on the socket-close path.
   */
  reapDeadClients(isAlive: (pid: number) => boolean): number {
    if (this.clients.size === 0) return 0;
    let reaped = 0;
    for (const session of [...this.clients]) {
      const peers = this.clientPeers.get(session);
      if (!peers || !peerIsDead(peers, isAlive)) continue;
      process.stderr.write(
        `[CodeGraph daemon] Reaping client with dead peer (pid ${peers.pid}); clients=${this.clients.size - 1}.\n`
      );
      try { session.stop(); } catch { /* best-effort */ }
      this.dropClient(session);
      reaped++;
    }
    return reaped;
  }

  private cleanupLockfile(): void {
    try {
      if (fs.existsSync(this.pidPath)) {
        // Only remove if it still belongs to us — another server may have
        // already taken over while we were shutting down (extremely rare).
        const raw = fs.readFileSync(this.pidPath, 'utf8');
        const info = decodeServerLock(raw);
        if (info && info.pid === process.pid) {
          fs.unlinkSync(this.pidPath);
        }
      }
    } catch { /* best-effort; we're exiting anyway */ }
  }
}

/**
 * Identity of the state dir the server is about to publish in its lock record.
 * Both callers have already created the directory ({@link ensureStateDir}), so
 * null means it was removed under us: the server cannot say which state dir it
 * serves, and refuses to write a record nobody could judge.
 */
function requireStateDirIdentity(): string {
  const stateId = getStateDirIdentity();
  if (stateId === null) throw new Error(`The state dir ${getStateDir()} is gone; cannot publish the server lock.`);
  return stateId;
}

/**
 * Waits between retries of the pid-file replace on Windows, doubling to a cap:
 * eight attempts wait about 1.6s in all. Windows refuses to replace a file
 * while any handle to it is open, so an antivirus scan, an indexer, or another
 * session reading the lock can each hold it for a moment, and for longer on a
 * loaded machine (#1773). The total stays well inside a launcher's ~6s connect
 * window.
 */
const LOCK_REFRESH_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 400, 400];

/**
 * Publish the bound socket without abandoning a live server on a transient
 * Windows sharing violation. Keep this startup step synchronous: the record
 * must name the bound socket before any client can find the server through it.
 * Retries wait per {@link LOCK_REFRESH_RETRY_DELAYS_MS}; permanent failures
 * still abort startup. The new record is written to a private temp file
 * ({@link writeExclusiveTemp}: a fresh random name, created exclusively, so
 * nothing planted beside the lock is written through) and renamed over.
 */
export function refreshDaemonLock(
  pidPath: string,
  initialContents: string,
  lock: ServerLockInfo,
  platform: NodeJS.Platform = process.platform,
): void {
  const tmpPid = writeExclusiveTemp(pidPath, encodeServerLock(lock), 0o600);
  try {
    for (let attempt = 0; ; attempt++) {
      // A retry must never replace a record whose owner changed while waiting.
      if (fs.readFileSync(pidPath, 'utf8') !== initialContents) {
        throw new Error('Lost server lock ownership after binding.');
      }
      try {
        fs.renameSync(tmpPid, pidPath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const delay = LOCK_REFRESH_RETRY_DELAYS_MS[attempt];
        if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || delay === undefined) {
          throw error;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      }
    }
  } finally {
    try { fs.unlinkSync(tmpPid); } catch { /* renamed, or best-effort cleanup */ }
  }
}

/**
 * Result of `tryAcquireDaemonLock`. Either we got the lockfile (caller becomes
 * the server), or it already existed (caller should defer to the existing
 * server, or — if the holder is dead — clear it and retry).
 */
export type AcquireResult =
  | { kind: 'acquired'; pidPath: string; info: ServerLockInfo }
  | {
      kind: 'taken';
      existing: ServerLockInfo | null;
      /** Exact record read after losing acquisition; null when it was unreadable. */
      lockContents: string | null;
      pidPath: string;
    };

/**
 * Atomically create the server pidfile (`<state>/server.pid`) with its full record already in place.
 * Returns either an `acquired` result (the caller is the server-elect and may
 * construct a {@link Daemon}) or a `taken` result.
 *
 * The lock appears in one atomic step with its full record: written to a private
 * temp file, then hard-linked into place. `link()` is atomic AND exclusive
 * (EEXIST if the target exists), so the pidfile becomes visible already
 * containing a full record. Whoever links first wins; everyone else gets EEXIST
 * and reads a complete file. A reader can never see an empty pidfile and
 * unlink the winner's lock.
 *
 * The record names the state directory it was written for
 * ({@link ServerLockInfo.stateId}, the directory's identity, not a path). A
 * state directory copied elsewhere carries its source's live record along,
 * which the caller recognises by that field and clears (see
 * `startDaemonProcess`). Every other record is decided by
 * pid liveness and the socket hello.
 *
 * Filesystems without hard links (#997): ExFAT/FAT external volumes and some
 * network mounts can't `link()` at all — it throws ENOTSUP/EPERM, which would
 * otherwise kill the daemon before it ever reaches the socket bind. There we
 * fall back to an O_EXCL create (`acquireLockViaExclusiveOpen`): still exclusive
 * ("first writer wins"), but the full record is written through the fd in a
 * second step, so the empty-file window the link approach removes is reopened —
 * only on these filesystems, only for the microseconds between create and write.
 * The race's worst case is two daemons briefly; on a single external
 * drive that's strictly better than the daemon never starting at all.
 */
export function tryAcquireDaemonLock(): AcquireResult {
  const pidPath = getServerPidPath();
  // The state directory may not exist yet: the first server on a machine (or on
  // a development build's own state dir) is the first thing to touch it.
  ensureStateDir();

  const info: ServerLockInfo = {
    pid: process.pid,
    version: CodeGraphPackageVersion,
    socketPath: getServerSocketPath(),
    startedAt: Date.now(),
    stateDir: getStateDir(),
    stateId: requireStateDirIdentity(),
  };

  // The temp name is drawn fresh per call and the file created exclusively
  // (writeExclusiveTemp), so racing candidates, worker threads sharing a pid
  // included, never collide on it and nothing planted there is written through.
  const tmp = writeExclusiveTemp(pidPath, encodeServerLock(info), 0o600);
  let acquired = false;
  try {
    try {
      fs.linkSync(tmp, pidPath); // atomic + exclusive (race-free; see the doc above)
      acquired = true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // Lost the race — another candidate already holds it. Fall through to read.
      } else {
        // link() failed for a non-conflict reason — nearly always "this filesystem
        // has no hard links" (ExFAT/FAT external volumes, some network mounts),
        // which surfaces as a DIFFERENT errno on every OS: ENOTSUP on macOS, EPERM
        // on Linux, EISDIR on Windows (#997). Enumerating them is whack-a-mole and
        // unnecessary: the `tmp` write above already proved this directory is
        // writable, so an O_EXCL create is a valid atomic+exclusive substitute. If
        // IT fails too, that's a genuine error and propagates. EEXIST ⇒ taken.
        acquired = acquireLockViaExclusiveOpen(pidPath, info);
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* temp already gone */ }
  }

  if (acquired) return { kind: 'acquired', pidPath, info };

  // Taken. On the link path the pidfile always holds a complete record, so
  // `existing` is null only for a corrupt leftover; on the O_EXCL fallback it
  // can also be a holder mid-write. Either way `lockContents` keeps the exact
  // bytes so the caller can hand them to clearStaleDaemonLock as
  // `expectedLockContents`, which removes the lock only if it still holds them.
  let existing: ServerLockInfo | null = null;
  let lockContents: string | null = null;
  try {
    lockContents = fs.readFileSync(pidPath, 'utf8');
    existing = decodeServerLock(lockContents);
  } catch { /* unreadable lockfile — treat as malformed */ }
  return { kind: 'taken', existing, lockContents, pidPath };
}

/**
 * Exclusive-create the pidfile (O_CREAT|O_EXCL via the `wx` flag) and write the
 * full record through the same fd — the hard-link-free fallback used by
 * {@link tryAcquireDaemonLock} on filesystems without `link()`. Returns true if
 * we created it (acquired the lock), false on EEXIST (another candidate holds
 * it). Any other error propagates. Still exclusive, so "first writer wins" holds
 * exactly as the link path does; the only difference is the brief empty-file
 * window between create and write. Exported for testing.
 */
export function acquireLockViaExclusiveOpen(pidPath: string, info: ServerLockInfo): boolean {
  let fd: number;
  try {
    fd = fs.openSync(pidPath, 'wx', 0o600); // O_CREAT | O_EXCL | O_WRONLY
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, encodeServerLock(info));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * Remove a stale pidfile. The file is read once ({@link snapshotLock}), judged
 * from that read, and removed with {@link removeLockIfUnchanged}: under the
 * `.takeover` guard and only if it is still that very file (same bytes and,
 * off Windows, same inode), so a different daemon that acquired the lock after
 * the read is never disturbed. A guard another live taker holds leaves the
 * lock in place and returns false.
 *
 * Passing `expectedDeadPid` (the pid the caller believed dead) makes the clear
 * bail if the file holds a different pid. By default a live pid is also
 * preserved; `allowLivePid` is reserved for callers that have already disproved
 * the holder's identity: the socket hello did not match the record (a pid the
 * OS reused, #1553), or the record names another state directory (a state dir
 * copied along with its source's live record). The `expectedLockContents` and
 * `expectedDeadPid` compares still apply first. Returns true when the stale
 * lock is gone (or was already gone).
 */
export function clearStaleDaemonLock(
  pidPath: string,
  expectedDeadPid?: number,
  opts: { allowLivePid?: boolean; expectedLockContents?: string } = {}
): boolean {
  try {
    const snapshot = snapshotLock(pidPath);
    if (snapshot === null) return true; // already gone
    const raw = snapshot.raw;
    // The identity record changed after the caller inspected it. Even the same
    // PID may now advertise a newly-bound socket, so this snapshot was never
    // disproved and must not be deleted.
    if (opts.expectedLockContents !== undefined && raw !== opts.expectedLockContents) return false;
    const info = decodeServerLock(raw);
    if (info) {
      // A different pid took over since we read it — not ours to clear.
      if (expectedDeadPid !== undefined && info.pid !== expectedDeadPid) return false;
      // PID liveness is normally sufficient. The takeover caller may override
      // it only after a failed identity handshake (or a foreign state dir)
      // disproves the holder.
      if (!opts.allowLivePid && info.pid > 0 && isProcessAlive(info.pid)) return false;
    }
    const removed = removeLockIfUnchanged(pidPath, snapshot);
    return removed === 'removed' || removed === 'gone';
  } catch {
    // Unreadable, or the unlink itself failed: the lock is still there.
    return false;
  }
}

/**
 * The one `listen()` error we must NOT relocate past. EADDRINUSE means the path
 * is genuinely occupied — a racing daemon that legitimately owns it, or a
 * leftover node we couldn't clear (the #974 planted-dir case) — so relocating
 * would abandon a path another daemon owns; the caller instead releases its lock
 * and every launcher serves in-process. EVERY OTHER bind error just means "this path
 * didn't work," almost always a filesystem that can't host an AF_UNIX node at all
 * (ExFAT/FAT, network mounts, WSL2 DrvFs), which reports a DIFFERENT errno per OS
 * (a different errno per OS; #997), or a path past the OS length limit (the tmpdir
 * candidate is never length-checked, so a long TMPDIR reaches here). Enumerating the "unsupported" codes is whack-a-mole, so we relocate
 * on anything-but-conflict instead — robust and self-correcting: if the deterministic
 * tmpdir fallback ALSO fails, bindFirstUsableSocket throws a {@link SocketBindError}
 * naming every attempt.
 */
const SOCKET_BIND_CONFLICT_CODE = 'EADDRINUSE';

/**
 * Bind codes that may mean the socket path is too long. EINVAL is what Darwin 27.2 with
 * Node 26 returned at 254 bytes and more (measured); ENAMETOOLONG is listed for other
 * systems and is not measured. Either code can have another cause, so the message line
 * that uses this set is a hint.
 */
const SOCKET_PATH_LENGTH_CODES = ['EINVAL', 'ENAMETOOLONG'];

/**
 * Every candidate failed to bind for a non-conflict reason, or the list was empty (the
 * state dir is missing, or none was given). `attempts` is each tried path in order with
 * its UTF-8 byte length (the unit of the kernel's sun_path limit) and error code; `code`
 * and `cause` are the LAST attempt's. With no attempts, `code` is ENOENT and `cause` is
 * unset. The serve command prints the message after a `Failed to start server:` prefix,
 * so it names every path and hints what to shorten when a length-type code was among them.
 */
export class SocketBindError extends Error {
  readonly code: string;
  readonly attempts: { socketPath: string; bytes: number; code: string }[];

  constructor(
    message: string,
    code: string,
    attempts: { socketPath: string; bytes: number; code: string }[],
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SocketBindError';
    this.code = code;
    this.attempts = attempts;
  }
}

/**
 * Bind the first usable socket from an ordered candidate list, relocating past
 * any path that fails to bind for a non-conflict reason (see {@link
 * SOCKET_BIND_CONFLICT_CODE}). The injected `listen` does the real
 * `net.Server.listen` (and stale-socket clear); abstracted so the relocation
 * policy is unit-testable without a real unsupported filesystem. Returns the
 * server plus the path actually bound. An EADDRINUSE propagates as the raw error.
 * When every candidate fails for another reason, a {@link SocketBindError} lists
 * each attempt, then each of `opts.skipped` (candidates the caller left off the
 * list, with why), and the caller releases the lockfile so every launcher serves
 * in-process. Exported for testing.
 */
export async function bindFirstUsableSocket(
  candidates: string[],
  listen: (socketPath: string) => Promise<net.Server>,
  opts: {
    onRelocate?: (from: string, to: string, code: string) => void;
    skipped?: { socketPath: string; reason: string }[];
  } = {},
): Promise<{ server: net.Server; socketPath: string }> {
  const attempts: { socketPath: string; bytes: number; code: string }[] = [];
  let lastErr: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const socketPath = candidates[i]!; // i < length, so always defined
    const isLast = i === candidates.length - 1;
    try {
      const server = await listen(socketPath);
      return { server, socketPath };
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === SOCKET_BIND_CONFLICT_CODE) throw err;
      attempts.push({ socketPath, bytes: Buffer.byteLength(socketPath), code: code ?? 'UNKNOWN' });
      if (!isLast) {
        opts.onRelocate?.(socketPath, candidates[i + 1]!, code ?? ''); // !isLast ⇒ i+1 in range
        continue;
      }
    }
  }
  // An empty candidate list gets here without an attempt: a caller passing none, or the state
  // dir missing or deleted between taking the lock and binding (the candidates are keyed on its
  // identity, so `getServerSocketCandidates()` is then empty). No attempt means no cause to carry.
  const last = attempts[attempts.length - 1];
  if (last === undefined) {
    throw new SocketBindError(
      'Could not bind the CodeGraph server socket: there are no socket candidates (the state dir is missing, or none were given).',
      'ENOENT',
      attempts,
    );
  }
  const lines = [
    'Could not bind the CodeGraph server socket; every candidate failed:',
    ...attempts.map((a) => `  ${a.socketPath} (${a.bytes} bytes): ${a.code}`),
    ...(opts.skipped ?? []).map(
      (s) => `  ${s.socketPath} (${Buffer.byteLength(s.socketPath)} bytes): skipped, ${s.reason}`,
    ),
  ];
  if (attempts.some((a) => SOCKET_PATH_LENGTH_CODES.includes(a.code))) {
    lines.push(
      "A socket path this long may be over this machine's limit: shorten TMPDIR or the state dir (CODEGRAPH_STATE_DIR).",
    );
  }
  throw new SocketBindError(lines.join('\n'), last.code, attempts, lastErr);
}

function resolveClientSweepMs(): number {
  const raw = process.env.CODEGRAPH_DAEMON_CLIENT_SWEEP_MS;
  if (raw === undefined || raw === '') return DEFAULT_CLIENT_SWEEP_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CLIENT_SWEEP_MS;
  return Math.floor(parsed); // 0 disables the sweep
}

function resolveInstallCheckMs(): number {
  const raw = process.env.CODEGRAPH_DAEMON_INSTALL_CHECK_MS;
  if (raw === undefined || raw === '') return DEFAULT_INSTALL_CHECK_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_INSTALL_CHECK_MS;
  return Math.floor(parsed); // 0 disables the check
}

/**
 * Parse one client-hello line. Returns the peer pids, launch directory and
 * session scope if `line` is a well-formed client-hello (carries the
 * `codegraph_client` marker), or null otherwise — in which case the caller
 * treats the bytes as ordinary JSON-RPC. A `launchDir` that is not an absolute
 * path reads as absent: the session then has no anchor rather than one anchored
 * on a relative path. `focus` is kept only as an array of at most
 * `MAX_FOCUS_ENTRIES` strings and `tools` only as a string; any other shape
 * (including a longer focus list, which the CLI never sends) leaves the property
 * absent, as if the hello had not sent it.
 */
export function parseClientHelloLine(line: string): ClientPeers | null {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (o.codegraph_client !== 1 || typeof o.pid !== 'number') return null;
  const peers: ClientPeers = {
    pid: o.pid,
    hostPid: typeof o.hostPid === 'number' ? o.hostPid : null,
    launchDir: typeof o.launchDir === 'string' && path.isAbsolute(o.launchDir) ? o.launchDir : null,
    hasLaunchDir: o.launchDir !== undefined,
    control: o.control === 1,
  };
  if (Array.isArray(o.focus) && o.focus.length <= MAX_FOCUS_ENTRIES && o.focus.every((d) => typeof d === 'string')) {
    peers.focus = o.focus as string[];
  }
  if (typeof o.tools === 'string') peers.tools = o.tools;
  return peers;
}

/**
 * A client's peer is dead when its proxy process is gone, or when its known
 * host process is gone. Unknown pid (no client-hello) is never "dead" on this
 * basis — those clients rely on the socket-close path. Exported for testing.
 */
export function peerIsDead(
  peers: { pid: number | null; hostPid: number | null },
  isAlive: (pid: number) => boolean,
): boolean {
  if (peers.pid === null) return false;
  if (!isAlive(peers.pid)) return true;
  if (peers.hostPid !== null && !isAlive(peers.hostPid)) return true;
  return false;
}

/**
 * Read the optional client-hello line a proxy sends after the server hello.
 * Always resolves (never rejects) — fail-safe by design, since every connection
 * funnels through here. Resolves with the peer pids, launch directory and session scope when
 * the first line is a client-hello; otherwise resolves with null peers and unshifts the already-read
 * bytes so the transport parses them as the client's first JSON-RPC message(s).
 * Accumulates as Buffers and splits on the newline byte so a UTF-8 sequence
 * straddling a chunk boundary in the unshifted tail is never corrupted.
 */
function readClientHello(socket: net.Socket): Promise<ClientPeers> {
  return new Promise((resolve) => {
    let chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (peers: ClientPeers, putBack?: Buffer) => {
      if (settled) return;
      settled = true;
      // PAUSE before detaching: removing the last 'data' listener does NOT
      // stop a flowing stream, so bytes arriving (or unshifted) in the gap
      // between this handler and the session transport attaching were emitted
      // to zero listeners and silently DISCARDED — and the listener swap left
      // the socket's flow state wedged, never delivering to the new listener.
      // A proxy whose client-hello arrived glued to the initialize hit this
      // ~1-in-5 under load: the daemon answered nothing for the whole session
      // (the #662 test flake, and real dead sessions behind it). Paused, the
      // unshifted tail and any new bytes buffer; SocketTransport.start()
      // resumes explicitly.
      try { socket.pause(); } catch { /* stream already gone */ }
      socket.removeListener('data', onData);
      socket.removeListener('error', onEnd);
      socket.removeListener('close', onEnd);
      clearTimeout(timer);
      if (process.env.CODEGRAPH_MCP_DEBUG) {
        process.stderr.write(`[mcp-debug] clientHello finish pid=${String(peers.pid)} putBack=${putBack ? putBack.length : 0} flowing=${String(socket.readableFlowing)}\n`);
      }
      if (putBack && putBack.length > 0 && !socket.destroyed) {
        try { socket.unshift(putBack); } catch { /* stream already gone */ }
      }
      resolve(peers);
    };
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      chunks.push(buf);
      total += buf.length;
      const all = chunks.length === 1 ? buf : Buffer.concat(chunks, total);
      const nl = all.indexOf(0x0a); // '\n'
      if (nl === -1) {
        // No newline yet. If it's already too long to be a hello, it isn't one —
        // hand the bytes back as data; otherwise keep accumulating.
        if (total > MAX_HELLO_LINE_BYTES) finish(NO_PEERS, all);
        else chunks = [all];
        return;
      }
      const peers = parseClientHelloLine(all.subarray(0, nl).toString('utf8'));
      if (peers) {
        const tail = all.subarray(nl + 1);
        finish(peers, tail.length > 0 ? tail : undefined);
      } else {
        // First line is not a client-hello (legacy/direct client) — hand the
        // whole buffer back so the transport sees the message verbatim.
        finish(NO_PEERS, all);
      }
    };
    const onEnd = () => finish(NO_PEERS);
    // On timeout, hand back whatever partial bytes accumulated — discarding
    // them would tear the first message the transport parses.
    const timer = setTimeout(() => {
      const partial = chunks.length === 0 ? undefined : (chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total));
      finish(NO_PEERS, partial);
    }, CLIENT_HELLO_TIMEOUT_MS);
    timer.unref?.();
    socket.on('data', onData);
    socket.on('error', onEnd);
    socket.on('close', onEnd);
  });
}

/** Exported for test stubs that need to bound the hello-line read. */
export { MAX_HELLO_LINE_BYTES };
