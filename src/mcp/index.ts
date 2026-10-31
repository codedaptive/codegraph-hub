/**
 * CodeGraph MCP Server
 *
 * Model Context Protocol server that exposes CodeGraph functionality
 * as tools for AI assistants like Claude.
 *
 * @module mcp
 *
 * @example
 * ```typescript
 * import { MCPServer } from 'codegraph';
 *
 * const server = new MCPServer('/path/to/project');
 * await server.start();
 * ```
 *
 * Runtime modes (decided in {@link MCPServer.start}):
 *
 * - **Proxy** — what an MCP host actually talks to: a thin stdio front that
 *   answers the handshake locally and forwards tool calls to the machine
 *   server. The proxy carries the #277 PPID watchdog, so a SIGKILL'd host reaps
 *   its proxy promptly, and it serves calls in-process (read-only) while the
 *   server is unreachable. See {@link ./proxy.ts}.
 * - **Server** (the `Daemon` class) — a *detached* background process (its own
 *   session/process group, cwd = the state directory) that serves every proxy
 *   of this state directory over a Unix-domain socket / named pipe. One per
 *   computer, never rooted at a project, never exiting when idle. Spawned by
 *   the first launcher that finds none; never a child of any host, so it
 *   survives individual sessions. See {@link ./daemon.ts}, issue #411.
 * - **Direct** — one process serves one MCP client over stdio, with its own
 *   writable engine. Used only when the user opts out
 *   (`CODEGRAPH_NO_DAEMON=1`) or the proxy path fails during setup.
 *
 * The server is detached, so closing one host's terminal cannot sever the
 * others; the proxy keeps the PPID watchdog, so a killed host still reaps its
 * proxy.
 *
 * Every mode answers for one repository: the directory the session was launched
 * in (`-p`, else the cwd) fixes a repo anchor, and every tool call must name a
 * `projectPath` inside it (see `src/extensions/host/server/repo-anchor.ts`).
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, StdioOptions } from 'child_process';
import { getCodeGraphDir } from '../directory';
import { StdioTransport } from './transport';
import { MCPEngine } from './engine';
import { MCPSession } from './session';
import {
  Daemon,
  clearStaleDaemonLock,
  tryAcquireDaemonLock,
} from './daemon';
import { stopServer, isProcessAlive, readServerLock, namesThisStateDir } from './server-control';
import { connectWithHello, DAEMON_HELLO_TIMEOUT_MS, runLocalHandshakeProxy } from './proxy';
import { CodeGraphPackageVersion } from './version';
import {
  getServerLogPath,
  getServerSocketCandidates,
  probeServerIdentity,
} from './daemon-paths';
import { ensureStateDir } from '../extensions/host/server/state-dir';
import { resolveRepoAnchor, type RepoAnchor } from '../extensions/host/server/repo-anchor';
import { BuilderClient } from '../extensions/host/builder/client';
import { parseToolAllowlist, sessionFocusEntries } from '../extensions/host/server/session-scope';
import { getTelemetry } from '../telemetry';
import { checkForUpdateInBackground } from '../upgrade/update-check';
import { EARLY_PPID } from './early-ppid';
import { supervisionLostReason, parsePpidPollMs, parseHostPpid } from './ppid-watchdog';
import { installMainThreadWatchdog, WatchdogHandle } from './liveness-watchdog';
import { armStartupHandshakeTimeout } from './startup-handshake';
import { treatStdinFailureAsShutdown } from './stdin-teardown';
import { HOST_PPID_ENV } from '../extraction/wasm-runtime-flags';

/** Default worker cap for a direct (single-client) session; see MCPEngineOptions.queryPoolDefaultMax (#1465). */
const DIRECT_QUERY_POOL_MAX = 2;

/**
 * Env var that marks a process as the *detached server* itself (set by
 * {@link spawnDetachedDaemon} when it re-invokes the CLI). Without it a
 * `serve --mcp` invocation is a launcher that connects-or-spawns; with it, the
 * process IS the server and must never try to spawn another (infinite spawn).
 */
const DAEMON_INTERNAL_ENV = 'CODEGRAPH_DAEMON_INTERNAL';

/**
 * Retries for the detached server arbitrating the lock against a racing
 * sibling. Tiny — the lock resolves on the first round in practice; the retries
 * only cover clearing a stale lockfile: a dead holder, one that did not answer
 * as the server, or a copied state dir's record.
 */
const TAKEOVER_MAX_RETRIES = 5;
const TAKEOVER_RETRY_DELAY_MS = 100;

/**
 * The in-process fallback engine: it serves reads when the machine server cannot
 * be reached. Rootless and read-only (#1963), with no index builder: no watcher,
 * no sync, no seeding of a worktree's index, no cold build, no project-registry
 * entry and no writer or `codegraph.lock` (an engine without a builder makes the
 * tool handler skip the seed step, and every project it opens is opened
 * read-only). A call at a worktree with no index of its own gets the not-indexed
 * guidance. So it can never conflict with a server (or another session's
 * fallback) that starts later. Say so on stderr: otherwise a session that
 * quietly stopped syncing looks the same as a healthy one in the logs.
 */
function makeFallbackEngine(): MCPEngine {
  process.stderr.write('[CodeGraph MCP] Serving reads in-process without auto-sync: the CodeGraph server is not reachable.\n');
  return new MCPEngine();
}

/**
 * How long a launcher waits for a freshly-spawned server to answer before
 * giving up and running in-process. The server binds the socket before it opens
 * any project, so this only needs to cover node process startup: 6s of headroom
 * for a cold/slow box; on the common path the socket appears within a few
 * rounds.
 *
 * A budget of wall time, not a count of probes. A process that holds the pipe
 * but never says hello — in practice a daemon whose main thread is blocked —
 * makes every probe wait out its whole hello timeout, so the old 240 probes
 * held a session's first tool call for about 12 minutes. Spent, the session is
 * served in-process exactly as when the daemon never binds, and the proxy keeps
 * retrying with backoff (#2277): a daemon its liveness watchdog kills (60s by
 * default) is replaced by the next retry, never bypassed for good.
 */
const DAEMON_CONNECT_BUDGET_MS = 6_000;
// Poll finely (25ms) so the proxy attaches the instant the freshly-spawned
// daemon binds, instead of waiting up to a coarse 100ms after — shaves the
// cold-start handshake (the window the headless agent races); socket-connect
// probes are cheap. Paired with deferring the CodeGraph load (engine.ts) off the
// bind path, this narrows the "No such tool available" race window.
const DAEMON_CONNECT_RETRY_DELAY_MS = 25;

/**
 * Probe the server's socket candidates in order (the state-dir path first);
 * the first that answers wins. With a `deadline`, no hello wait runs past it.
 * The connect and the clock are injectable for tests.
 */
export async function connectAnyDaemonCandidate(
  candidates: readonly string[],
  deadline = Infinity,
  connect: typeof connectWithHello = connectWithHello,
  now: () => number = Date.now,
): Promise<Awaited<ReturnType<typeof connectWithHello>>> {
  for (const candidate of candidates) {
    const left = deadline - now();
    if (left <= 0) return null;
    const s = await connect(candidate, CodeGraphPackageVersion, Math.min(DAEMON_HELLO_TIMEOUT_MS, left));
    // A wrong-version daemon IS up — definitive; propagate so the caller
    // replaces it (an older release) or serves in-process instead of
    // spawning + polling for 6s. Don't keep probing fallbacks past it.
    if (s) return s;
  }
  return null;
}

/**
 * Probe for a daemon every `retryDelayMs` until one answers or `budgetMs` of
 * wall time is spent. `probe` gets the deadline, and caps its own hello wait to
 * it. Resolves the socket, or null once the budget is spent or a daemon of
 * another version answers. The clock is injectable for tests.
 */
export async function pollForDaemon<S>(
  probe: (deadline: number) => Promise<S | 'older-version' | 'version-mismatch' | null>,
  budgetMs: number = DAEMON_CONNECT_BUDGET_MS,
  retryDelayMs: number = DAEMON_CONNECT_RETRY_DELAY_MS,
  clock: { now(): number; sleep(ms: number): Promise<void> } = { now: Date.now, sleep },
): Promise<S | null> {
  const deadline = clock.now() + budgetMs;
  for (;;) {
    await clock.sleep(retryDelayMs);
    if (clock.now() >= deadline) return null;
    const answer = await probe(deadline);
    // An answer from another version ends the poll now; the caller replaces an
    // older server or serves in-process.
    if (answer === 'older-version' || answer === 'version-mismatch') return null;
    if (answer) return answer;
  }
}

/** Whether `CODEGRAPH_NO_DAEMON` was set to a truthy value. */
function daemonOptOutSet(): boolean {
  const raw = process.env.CODEGRAPH_NO_DAEMON;
  if (!raw) return false;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

/** Whether this process was spawned to BE the detached daemon. */
function daemonInternalSet(): boolean {
  const raw = process.env[DAEMON_INTERNAL_ENV];
  return !!raw && raw !== '0' && raw.toLowerCase() !== 'false';
}

/**
 * Prefix every `process.stderr.write` chunk with an ISO-8601 timestamp. Called
 * once, only when this process becomes the detached server — whose stderr is
 * appended to `<state>/server.log`. Before #1431 no log line carried a
 * timestamp, so watchdog kills and restarts could be counted but never placed
 * in time. (The watchdog child writes its kill notice through its own
 * inherited fd 2, bypassing this wrapper — it stamps that line itself.)
 */
export function timestampStderrLines(): void {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    return (orig as (...args: unknown[]) => boolean)(stampLogChunk(chunk), ...rest);
  }) as typeof process.stderr.write;
}

/** Prepend `[<ISO-8601>] ` to a log chunk; unknown chunk types pass through. */
export function stampLogChunk(chunk: string | Uint8Array): string | Uint8Array {
  try {
    const stamp = `[${new Date().toISOString()}] `;
    if (typeof chunk === 'string') return stamp + chunk;
    if (Buffer.isBuffer(chunk)) return Buffer.concat([Buffer.from(stamp), chunk]);
  } catch { /* stamping is best-effort; never block the write */ }
  return chunk;
}

/**
 * Watchdog `progressPaths` for a process serving `root`'s index: the SQLite DB
 * + its WAL. Null (the machine server and the proxy have no root of their own;
 * the index builder, a separate process, writes every index) gives none. With
 * these, the #850 liveness watchdog only kills on heartbeat
 * silence when the DB files are NOT advancing — the same slow-disk deferral
 * the CLI `index`/`init` path got in #1231. Without it, one >timeout
 * synchronous statement on a big DB (multi-GB index behind Windows Defender)
 * SIGKILLs a perfectly healthy daemon — and a daemon SIGKILL'd at the end of
 * nearly every session is what ratcheted the WAL leak in #1431. A true wedge
 * still dies: a wedged loop writes nothing, so the files stay still.
 */
export function watchdogProgressPaths(root: string | null): { progressPaths?: string[] } {
  if (!root) return {};
  const dbPath = path.join(getCodeGraphDir(root), 'codegraph.db');
  return { progressPaths: [dbPath, `${dbPath}-wal`] };
}

/**
 * The directory this session was launched in, absolute and symlink-resolved:
 * `-p` when given, else the process cwd. It fixes the session's repo anchor, so
 * every spelling of one directory (a symlinked cwd, macOS `/var` vs
 * `/private/var`) must reach the server as one string; the anchor resolver
 * canonicalizes further (git root, common dir).
 */
function resolveLaunchDir(explicitPath: string | null): string {
  const candidate = path.resolve(explicitPath ?? process.cwd());
  try { return fs.realpathSync(candidate); } catch { return candidate; }
}

/**
 * Spawn the machine server as a fully detached background process: its own
 * session/process group (so a SIGHUP/SIGINT to the launcher's terminal can't
 * reach it) with stdio decoupled from the launcher (logs to
 * `<state>/server.log`) and its cwd the state directory, so it is not rooted in
 * any project and pins no one's directory. Re-invokes the *same* CLI faithfully
 * across dev and bundled launches by reusing `process.execPath` (the right
 * node), the current `process.execArgv` (carries `--liftoff-only`, so the server
 * never re-execs) and `process.argv[1]` (this script). No `--path`: the server
 * has no project. The spawned process self-arbitrates the lock, so
 * racing launchers may each spawn one — losers exit and every launcher proxies
 * through the single winner.
 */
function spawnDetachedDaemon(): void {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    // No resolvable CLI entry point to re-invoke — let the caller serve
    // in-process rather than spawn something broken.
    throw new Error('cannot resolve CLI script path to spawn the server');
  }

  const stateDir = ensureStateDir();
  let logFd: number | null = null;
  let stdio: StdioOptions = 'ignore';
  try {
    logFd = fs.openSync(getServerLogPath(), 'a');
    stdio = ['ignore', logFd, logFd];
  } catch {
    stdio = 'ignore'; // no log file — discard server output rather than fail
  }
  try {
    // The server has no host: scrub the threaded host pid so it can't leak
    // into the server's env (and from there into anything the server spawns),
    // where a long-dead session's host pid would trigger spurious shutdowns.
    const env: NodeJS.ProcessEnv = { ...process.env, [DAEMON_INTERNAL_ENV]: '1' };
    delete env[HOST_PPID_ENV];
    const child = spawn(
      process.execPath,
      [...process.execArgv, scriptPath, 'serve', '--mcp'],
      {
        detached: true,
        stdio,
        windowsHide: true,
        cwd: stateDir,
        env,
      },
    );
    // An upgrade can delete the install this launcher runs from — its server
    // then exits (#2335) and a respawn finds no executable. spawn reports that
    // as an asynchronous 'error' event, which would crash this process if
    // nobody listened. No server binds either way; the caller's poll gives up
    // and the session is served in-process.
    child.on('error', () => { /* no server — see above */ });
    child.unref();
  } finally {
    // The child holds its own dup of the log fd now; the launcher doesn't need it.
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch { /* ignore */ }
    }
  }
}

/**
 * How long a launcher replacing an older server waits for one that is partway
 * through its shutdown, past the stop's own signal. Tool calls are held
 * meanwhile, so it is short: a server that takes longer leaves the session
 * served in-process until the proxy's next retry (#2277) finds it gone.
 */
const OLDER_SERVER_SHUTDOWN_GRACE_MS = 5_000;

/**
 * Stop the server of this state dir when it runs an older install, so the
 * caller can start one from this install (#2335). A server keeps the code it
 * started with: one that outlived an upgrade went on loading grammars from the
 * removed install and wrote every file it re-indexed as empty.
 * {@link stopServer} proves the server by its socket hello and never stops one
 * of the same, a newer or an unknown version. `answered` says an older server
 * answered this launcher's own probe. Resolves `stopped` (the way is clear to
 * spawn one), `none` (no server holds the state dir), or `kept` (one does,
 * unverified, still shutting down, or not older).
 */
async function replaceOlderServer(answered: boolean): Promise<'stopped' | 'none' | 'kept'> {
  const result = await stopServer({
    onlyIfOlderThan: CodeGraphPackageVersion,
    graceMs: OLDER_SERVER_SHUTDOWN_GRACE_MS,
  });
  if (result.outcome === 'not-running') return 'none';
  const server = result.version
    ? `the CodeGraph ${result.version} server (pid ${result.pid})`
    : 'an older CodeGraph server';
  if (result.outcome === 'stopped') {
    process.stderr.write(
      `[CodeGraph MCP] Stopped ${server}; starting one from this install (${CodeGraphPackageVersion}).\n`
    );
    return 'stopped';
  }
  if (result.outcome === 'still-running') {
    process.stderr.write(`[CodeGraph MCP] Asked ${server} to stop, but it has not exited yet.\n`);
  } else if (answered) {
    process.stderr.write(
      `[CodeGraph MCP] Found ${server} but could not verify it, so left it running; serving this session in-process.\n`
    );
  }
  return 'kept';
}

/**
 * MCP Server for CodeGraph
 *
 * Implements the Model Context Protocol to expose CodeGraph
 * functionality as tools that can be called by AI assistants.
 *
 * Backwards-compatible constructor and `start()` signature: callers continue to do
 * `new MCPServer(path).start()`, where `path` is the launch directory (the
 * session's repo anchor is taken from it; the cwd when absent). `focus` is the
 * session's `--focus` directories, already validated and normalised by
 * `normaliseFocusArgs` (relative to the repository root; none when omitted).
 * Internally we pick from direct / proxy / server at start time.
 */
export class MCPServer {
  private projectPath: string | null;
  // Direct-mode-only state. In server mode the per-connection sessions live
  // inside the Daemon class; in proxy mode there is no session at all.
  private session: MCPSession | null = null;
  private engine: MCPEngine | null = null;
  // The index builder of a direct-mode session (null in the read-only fallback).
  private builder: BuilderClient | null = null;
  private daemon: Daemon | null = null;
  private ppidWatchdog: ReturnType<typeof setInterval> | null = null;
  // Worker-thread liveness watchdog (#850). Long-lived modes only; SIGKILLs the
  // process if the main thread wedges in a non-yielding sync loop.
  private livenessWatchdog: WatchdogHandle | null = null;
  // PPID watchdog baseline — from the CLI entry's earliest-possible capture
  // (early-ppid.ts). Capturing here (construction) already lost the race when
  // the launcher was killed during module loading (#1185).
  private originalPpid: number = EARLY_PPID;
  private hostPpid: number | null = parseHostPpid(process.env[HOST_PPID_ENV]);
  // Idempotency guard for stop().
  private stopped = false;
  private mode: 'unstarted' | 'direct' | 'proxy' | 'daemon' = 'unstarted';

  private focus: readonly string[];

  constructor(projectPath?: string, focus: readonly string[] = []) {
    this.projectPath = projectPath || null;
    this.focus = focus;
  }

  /**
   * Start the MCP server.
   *
   * Decision order:
   *   1. `CODEGRAPH_DAEMON_INTERNAL=1` → we ARE the detached machine server;
   *      listen.
   *   2. `CODEGRAPH_NO_DAEMON=1` → direct mode (the single-process behavior).
   *   3. Otherwise connect to (or spawn) the machine server and proxy to it.
   *      There is no "no `.codegraph/` here" branch: the server lives under the
   *      state directory and serves any repository the call names.
   *
   * On any unexpected failure in step 3 we transparently fall back to direct
   * mode — a misbehaving server must never block a session from starting.
   */
  async start(): Promise<void> {
    // Long-lived process (direct / proxy / daemon alike): flush buffered
    // telemetry opportunistically. Fire-and-forget + unref'd — adds nothing
    // to the handshake path and never keeps the process alive.
    getTelemetry().startInterval();

    // #1243: the MCP config launches the local binary, so a server left
    // running drifts behind releases with no signal. Refresh the shared
    // update-check cache in the background and log ONE stderr notice when a
    // newer version exists (stderr only — stdout is the protocol channel).
    // The notice also reaches the agent via the initialize instructions and
    // codegraph_status. Fire-and-forget: adds nothing to the handshake path.
    checkForUpdateInBackground();

    // The detached server process itself. Checked before the opt-out so the
    // server honors the same env it was spawned with (it never sets NO_DAEMON).
    if (daemonInternalSet()) {
      return this.startDaemonProcess();
    }

    // Direct mode if the user opted out. Setting the env var is sufficient to
    // get the single-process behavior.
    if (daemonOptOutSet()) {
      return this.startDirect('CODEGRAPH_NO_DAEMON set', true);
    }

    try {
      // Answer the MCP handshake LOCALLY (instant tool registration — no waiting
      // ~600ms for the server to spawn+bind, which produced the cold-start race)
      // and forward tool CALLS to the machine server, connected in the background.
      // Runs until the host disconnects; the proxy installs its own watchdog and
      // falls back to a read-only in-process engine if the server never comes up.
      this.mode = 'proxy';
      await this.runProxyWithLocalHandshake(resolveLaunchDir(this.projectPath));
      return;
    } catch (err) {
      // Belt-and-braces: a throw during proxy SETUP (before the client was served)
      // is still safe to recover from with a direct-mode session. A read-only one:
      // the setup failing says nothing about whether a server of this state
      // directory is running, and a second writer would conflict with it.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[CodeGraph MCP] Proxy path failed (${msg}); falling back to direct mode.\n`);
      return this.startDirect('proxy path threw', false);
    }
  }

  /**
   * Stop the server. In server mode this triggers graceful shutdown of every
   * connected session; in direct mode it stops the session and its engine (the
   * engine closes every project it opened) and exits. Proxy mode never
   * routes through here — the proxy exits itself.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ppidWatchdog) {
      clearInterval(this.ppidWatchdog);
      this.ppidWatchdog = null;
    }
    if (this.livenessWatchdog) {
      this.livenessWatchdog.stop();
      this.livenessWatchdog = null;
    }
    if (this.daemon) {
      void this.daemon.stop('stop()');
      // Daemon.stop completes the shutdown and exits.
      return;
    }
    if (this.session) {
      this.session.stop();
      this.session = null;
    }
    if (this.engine) {
      await this.engine.stop();
      this.engine = null;
    }
    // After the engine, which tells the builder to let go of each project.
    if (this.builder) {
      await this.builder.stop();
      this.builder = null;
    }
    process.exit(0);
  }

  /**
   * Single-process stdio MCP session. `builder` says whether it runs the index
   * builder (direct mode by choice) or is the read-only fallback with none.
   */
  private async startDirect(reason: string, builder: boolean): Promise<void> {
    if (reason && process.env.CODEGRAPH_MCP_DEBUG) {
      process.stderr.write(`[CodeGraph MCP] Direct mode: ${reason}.\n`);
    }

    // Supervision first: resolving the anchor below runs git and takes a moment
    // (longer on a loaded machine), and a host that dies in that window must not
    // leave this process unwatched (#277). The signal handlers and the PPID
    // watchdog need neither the session nor the transport.
    this.mode = 'direct';
    this.installSignalHandlers();
    this.installPpidWatchdog();

    // The session answers for the repository this process was launched in. No
    // writer slot is claimed here: this process never writes an index. The
    // engine opens projects on demand, read-only, and its builder (a child of
    // this process, like the machine server's) holds each one, taking the
    // writer slot of its index (a project another process writes is served
    // read-only meanwhile). With no builder (the fallback after a proxy setup
    // failure) the engine is the read-only in-process fallback, as when the
    // server cannot be reached.
    const anchor = await resolveAnchor(resolveLaunchDir(this.projectPath));

    if (builder) {
      this.builder = BuilderClient.start({
        onLog: (line) => process.stderr.write(`[CodeGraph MCP] ${line}\n`),
      });
      this.engine = new MCPEngine({ builder: this.builder, queryPool: true, queryPoolDefaultMax: DIRECT_QUERY_POOL_MAX });
    } else {
      this.engine = makeFallbackEngine();
    }
    const transport = new StdioTransport({ exitOnClose: false, onClose: () => { void this.stop(); } });
    // This process IS the one client, so its own focus and CODEGRAPH_MCP_TOOLS are
    // the session's, exactly as the machine server takes them from a client hello.
    this.session = new MCPSession(transport, this.engine, {
      anchor,
      focus: sessionFocusEntries(this.focus),
      toolAllowlist: parseToolAllowlist(process.env.CODEGRAPH_MCP_TOOLS ?? ''),
    });

    this.session.start();

    // Detect parent-process death — same logic as pre-refactor. When stdin
    // closes the transport drains the engine through stop(), but
    // SIGKILL of the parent doesn't reliably close stdin on Linux (#277).
    // Also treat a stdin `'error'` (a socket-backed stdin can fail with
    // ECONNRESET/hangup instead of a clean close) as shutdown, and destroy the
    // stream so a hung fd can't busy-spin the event loop (#799).
    treatStdinFailureAsShutdown(() => this.stop());
    // Backstop for a launch abandoned during startup (#1185): launcher killed
    // before EARLY_PPID could see it + host holding our pipes open. A server
    // that never receives a byte of MCP traffic isn't serving anyone. Armed
    // after session.start() attached the real stdin consumer.
    armStartupHandshakeTimeout(() => {
      process.stderr.write(
        '[CodeGraph MCP] No MCP traffic since startup; assuming an abandoned launch and shutting down (#1185). ' +
        'Tune with CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS (0 disables).\n'
      );
      this.stop();
    });

    this.livenessWatchdog = installMainThreadWatchdog(watchdogProgressPaths(anchor?.root ?? null));
  }

  /**
   * Run as the detached machine server (process spawned with
   * `CODEGRAPH_DAEMON_INTERNAL=1`). Arbitrate the lock, then either
   * become the server (bind the socket, serve forever) or — if a live server
   * already holds the lock — exit so we don't leak a redundant process.
   *
   * No PPID watchdog and no stdin handlers: the server is detached on purpose
   * and never exits because it is idle (see {@link Daemon}). It has no folder
   * of its own, so there is no sensitive-folder refusal here: what a session may
   * read is decided per call, by its repo anchor.
   */
  private async startDaemonProcess(): Promise<void> {
    // In server mode stderr IS `<state>/server.log`; stamp every line so
    // kills/restarts can be placed in time (#1431 — the log was undatable).
    timestampStderrLines();
    for (let attempt = 0; attempt < TAKEOVER_MAX_RETRIES; attempt++) {
      const lock = tryAcquireDaemonLock();

      if (lock.kind === 'acquired') {
        const daemon = new Daemon();
        await daemon.start();
        this.daemon = daemon;
        this.mode = 'daemon';
        // The detached server has no PPID watchdog or stdin lifeline, so a
        // wedged main thread would pin a core forever (#850). The liveness
        // watchdog is its only recovery path. It has no root, and no index
        // files to count as progress: this process writes none (the builder does).
        this.livenessWatchdog = installMainThreadWatchdog();
        return; // the net.Server keeps the process alive
      }

      // Taken. If the holder is alive, another server already serves (or is
      // binding) — we're redundant; exit cleanly so the launcher proxies to it.
      const existing = lock.existing;
      let disprovedLiveIdentity = false;
      if (existing && existing.pid > 0 && isProcessAlive(existing.pid)) {
        // A record that names another state dir was copied here with its source's
        // state dir: the live pid is the source's server, not this one's. Judged by
        // the directory's identity, never its path (namesThisStateDir): the live
        // server's own lock, reached through another spelling of this dir (a macOS
        // firmlink, a bind mount), names the same identity and is not a copy's.
        const copied = !namesThisStateDir(existing);
        // Give a newly-elected server time to bind, then require its socket hello
        // to match the lock PID/version. PID existence alone accepts an unrelated
        // process after OS PID reuse and permanently wedges startup (#1553).
        const age = Date.now() - existing.startedAt;
        const startupGraceMs = 10_000;
        const stillStarting = existing.startedAt > 0 && age >= 0 && age < startupGraceMs;
        if (!copied && (stillStarting || await probeServerIdentity(existing))) {
          process.stderr.write(
            `[CodeGraph daemon] Another server (pid ${existing.pid}) already holds the lock; exiting.\n`
          );
          process.exit(0);
        }
        disprovedLiveIdentity = true;
      }

      // The holder is dead, the record is unreadable, or a completed socket hello
      // (or a foreign state dir) disproved a live PID's identity. Revalidate the
      // exact record and retry the acquire only after cleanup succeeds safely.
      if (lock.lockContents !== null) {
        clearStaleDaemonLock(lock.pidPath, existing?.pid, {
          expectedLockContents: lock.lockContents,
          allowLivePid: disprovedLiveIdentity,
        });
      }
      await sleep(TAKEOVER_RETRY_DELAY_MS);
    }

    process.stderr.write('[CodeGraph daemon] Could not acquire the server lock; exiting.\n');
    process.exit(0);
  }

  /**
   * Proxy mode (the common case). Serve the MCP handshake LOCALLY for instant
   * tool registration, forwarding tool calls to the machine server — which is
   * connected in the background (probed, then spawned + polled if absent; one of
   * an older release is stopped first, #2335) so the handshake never waits
   * ~600ms on it. Runs until the host disconnects; the proxy falls back to a
   * read-only in-process engine if the server never binds, so this never wedges
   * a session. `launchDir` travels in the client hello and fixes the session's
   * repo anchor; the session's focus travels in the same hello, with this
   * process's CODEGRAPH_MCP_TOOLS.
   */
  private async runProxyWithLocalHandshake(launchDir: string): Promise<void> {
    // The server may relocate its socket past a state dir on a filesystem that
    // can't host one (ExFAT/FAT volumes, WSL2 DrvFs; #997) to the deterministic
    // tmpdir fallback. Both sides walk the SAME ordered candidate list, so we
    // converge on whichever the server bound with zero coordination. The
    // state-dir candidate is tried first, so a normal machine pays nothing extra
    // (it connects on the very first probe). The lock's own `socketPath` goes
    // ahead of them: the list's state-dir entry is spelled with this launcher's
    // path to the state dir, so a server bound through another spelling of the
    // same directory is still found. The list is read on every probe, not once:
    // it is empty while the state dir does not exist, and the spawn below creates it.
    const candidates = (): string[] => {
      const lock = readServerLock();
      return [...new Set([...(lock ? [lock.socketPath] : []), ...getServerSocketCandidates()])]
        .filter((p) => p.length > 0);
    };
    const connectAnyCandidate = (deadline?: number) => connectAnyDaemonCandidate(
      candidates(),
      deadline,
      (socketPath, version, helloTimeoutMs) => connectWithHello(socketPath, version, helloTimeoutMs, launchDir, this.focus),
    );
    const getDaemonSocket = async () => {
      // Fast path: a server may already be listening (on either candidate).
      const probe = await connectAnyCandidate();
      if (probe === 'version-mismatch') return null; // definitive — serve in-process, don't poll for 6s
      if (probe && probe !== 'older-version') return probe;
      // A server of an older release answered — or none did, while the lock may
      // still name one on a socket we don't probe. Either way it makes way for
      // one from this install (#2335).
      const answered = probe === 'older-version';
      const older = await replaceOlderServer(answered);
      if (older === 'kept' && answered) return null;
      // None reachable — spawn one (detached) and poll for its bind. Null when
      // nothing answered in time — never bound, or a holder that never says
      // hello: the proxy serves this session in-process.
      spawnDetachedDaemon();
      return await pollForDaemon(connectAnyCandidate);
    };
    await runLocalHandshakeProxy({ getDaemonSocket, makeEngine: makeFallbackEngine, launchDir, focus: this.focus });
  }

  /** Standard SIGINT/SIGTERM handlers that route to our `stop()` (direct mode). */
  private installSignalHandlers(): void {
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  /**
   * PPID watchdog (#277) — direct mode only. Server mode is detached on purpose
   * and has no host; proxy mode installs its own watchdog inside
   * {@link runLocalHandshakeProxy}. So this only ever runs for an in-process
   * direct session.
   */
  private installPpidWatchdog(): void {
    if (this.mode !== 'direct') return;
    const pollMs = parsePpidPollMs(process.env.CODEGRAPH_PPID_POLL_MS);
    if (pollMs <= 0) return;
    this.ppidWatchdog = setInterval(() => {
      const reason = supervisionLostReason({
        originalPpid: this.originalPpid,
        currentPpid: process.ppid,
        hostPpid: this.hostPpid,
        isAlive: isProcessAlive,
      });
      if (reason) {
        process.stderr.write(
          `[CodeGraph MCP] Parent process exited (${reason}); shutting down.\n`
        );
        this.stop();
      }
    }, pollMs);
    this.ppidWatchdog.unref();
  }
}

/**
 * The anchor of `launchDir`, or null when it cannot be resolved. The session then
 * answers a call without a projectPath with the missing-argument text, as always,
 * and a call that names a path with guidance to restart the session.
 */
async function resolveAnchor(launchDir: string): Promise<RepoAnchor | null> {
  try {
    return await resolveRepoAnchor(launchDir);
  } catch (err) {
    process.stderr.write(`[CodeGraph MCP] Could not resolve the repo anchor of ${launchDir}: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  // Deliberately NOT unref'd. During the daemon connect/takeover retry loop we
  // may be between processes — no socket bound yet, no transport, no listener
  // pinning the event loop. An unref'd timer would let Node drain the loop and
  // exit silently before we get a chance to try again.
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Export for use in CLI
export { StdioTransport } from './transport';
export { tools, ToolHandler } from './tools';
// Surface a few server-mode bits for tests + diagnostics.
export { Daemon } from './daemon';
export { CodeGraphPackageVersion } from './version';
