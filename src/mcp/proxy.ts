/**
 * MCP proxy mode — issue #411.
 *
 * The proxy is the process an MCP host actually spawns: a stdio front for the
 * machine server. It answers the MCP handshake locally (so tools register at
 * process-startup speed) and forwards every other message, byte for byte, to
 * the server over its socket; server replies stream straight back to the host's
 * stdout. When the server cannot be reached it serves tool calls in-process,
 * read-only, until a retry attaches (see {@link runLocalHandshakeProxy}).
 *
 * Lifecycle expectations:
 *   - The proxy exits when the host's stdin closes (or its host process dies).
 *   - Closing the socket on the proxy side is what tells the server to drop
 *     this client's session.
 *   - On a parent-process death we can't detect via stdin close (e.g. SIGKILL
 *     of the MCP host), the proxy's PPID watchdog catches it — same logic
 *     the direct-mode server uses; see issue #277.
 */

import * as fs from 'fs';
import * as net from 'net';
import { findNearestCodeGraphRoot } from '../directory';
import { HOST_PPID_ENV } from '../extraction/wasm-runtime-flags';
import { DaemonClientHello, DaemonHello, MAX_HELLO_LINE_BYTES } from './daemon';
import { EARLY_PPID } from './early-ppid';
import { supervisionLostReason } from './ppid-watchdog';
import { armStartupHandshakeTimeout } from './startup-handshake';
import { treatStdinFailureAsShutdown } from './stdin-teardown';
import { treatStdoutFailureAsShutdown } from './stdout-teardown';
import { CodeGraphPackageVersion, isOlderRelease } from './version';
import { SERVER_INFO, PROTOCOL_VERSION, initializeInstructions } from './session';
import { SERVER_INSTRUCTIONS } from './server-instructions';
import { getStaticTools } from './tools';
import { resolveRepoAnchor, type RepoAnchor } from '../extensions/host/server/repo-anchor';
import { dispatchToolCall } from '../extensions/host/server/tool-call';
import { parseToolAllowlist, sessionFocusEntries } from '../extensions/host/server/session-scope';
import { ErrorCodes } from './transport';
import { ExploreSessionState } from './explore-session-state';
import {
  INDEX_VERSION_WARNING_PREFIX,
  IndexVersionWarningState,
} from './index-version-warning';
import { getTelemetry, ClientInfo } from '../telemetry';
import { installMainThreadWatchdog, WatchdogHandle } from './liveness-watchdog';
import type { MCPEngine } from './engine';
import { WORKER_START_SETTLE_MS } from '../worker-teardown';

/** Default poll cadence for the PPID watchdog (same as the direct server). */
const DEFAULT_PPID_POLL_MS = 5000;

/**
 * How long a probe waits for a daemon's hello once connected. A healthy daemon
 * sends it the moment it accepts; one whose main thread is blocked accepts at
 * the OS level and never sends it.
 */
export const DAEMON_HELLO_TIMEOUT_MS = 3_000;

/**
 * How long a proxy serving in-process waits before trying the shared daemon
 * again, doubling after each miss up to the cap (#2277). Tunable through
 * `CODEGRAPH_DAEMON_RETRY_MS` (`0` turns retrying off) and
 * `CODEGRAPH_DAEMON_RETRY_MAX_MS`.
 */
const DEFAULT_DAEMON_RETRY_MS = 5_000;
const DEFAULT_DAEMON_RETRY_MAX_MS = 300_000;

/**
 * Longest the proxy waits, once it is shutting down, for its in-process engines
 * to stop before exiting anyway. An engine's stop waits up to
 * {@link WORKER_START_SETTLE_MS} for a query worker still starting up (exiting
 * mid-start can crash the process on Windows); this bounds a stop that never
 * settles (#2311).
 */
const SHUTDOWN_BACKSTOP_MS = WORKER_START_SETTLE_MS + 5_000;

/**
 * Env var that opts INTO the "attached to shared daemon" log line. Off by
 * default: the line is benign INFO, but MCP hosts render any server stderr at
 * error level (and append an `undefined` data field), so on every session start
 * a healthy attach showed up as `[error] … undefined`. Set to `1` to surface it
 * when debugging daemon attach. (#618; approach from #640 by @mturac)
 */
const LOG_ATTACH_ENV = 'CODEGRAPH_MCP_LOG_ATTACH';

/**
 * Log a successful daemon attach — gated behind {@link LOG_ATTACH_ENV} so it is
 * silent by default (see #618). Exported for tests.
 */
export function logAttachedDaemon(socketPath: string, hello: DaemonHello): void {
  if (process.env[LOG_ATTACH_ENV] !== '1') return;
  process.stderr.write(
    `[CodeGraph MCP] Attached to shared daemon on ${socketPath} (pid ${hello.pid}, v${hello.codegraph}).\n`
  );
}

/**
 * Connect to the server at `socketPath` and verify its hello (exact version
 * match). Returns the live socket (hello already consumed, client hello sent),
 * null if unreachable / stale, or — for a server of another version —
 * `'older-version'` when it runs an older release ({@link isOlderRelease}; the
 * launcher replaces it, #2335) and `'version-mismatch'` for any other version,
 * which is left alone. The caller owns the socket. Used by the local-handshake
 * proxy's background connect. `helloTimeoutMs` bounds the wait for the hello,
 * so a caller with a deadline can spend no more than it has. `launchDir` is the
 * directory this session was launched in; it travels in the client hello and
 * fixes the session's repo anchor on the server. `focus` is the session's
 * `--focus` directories (normalised, relative to the repository root; none
 * when omitted), which travel in the same hello.
 */
export async function connectWithHello(
  socketPath: string,
  expectedVersion: string = CodeGraphPackageVersion,
  helloTimeoutMs: number = DAEMON_HELLO_TIMEOUT_MS,
  launchDir?: string,
  focus?: readonly string[],
): Promise<net.Socket | 'older-version' | 'version-mismatch' | null> {
  if (process.platform !== 'win32' && !fs.existsSync(socketPath)) return null;
  const socket = net.createConnection(socketPath);
  socket.setEncoding('utf8');
  // Keep an 'error' listener attached for the socket's ENTIRE life. readHelloLine
  // attaches its own and then REMOVES it on success (its cleanup()), which left a
  // window — from here until the caller attaches its onDaemonLost handler — where
  // a socket 'error' had NO listener. In Node an unhandled socket 'error' is
  // re-thrown as an uncaughtException, which the global fatal handler turns into
  // process.exit(1); to an MCP client that surfaces as a bare "Transport closed"
  // (#974). The window is rarely hit on a healthy FS but is common on flaky
  // AF_UNIX-over-DrvFs (WSL2 /mnt drives). A no-op guard makes the error
  // recoverable: the follow-up 'close' drives the caller's normal fallback.
  socket.on('error', () => { /* absorbed — see #974; 'close' drives the fallback */ });
  const hello = await readHelloLine(socket, helloTimeoutMs).catch(() => null);
  if (!hello) {
    socket.destroy();
    return null; // no daemon yet — caller should keep polling
  }
  if (hello.codegraph !== expectedVersion) {
    // A server IS up but it's the wrong version — definitive, not a "not yet".
    socket.destroy();
    // An older release is the launcher's to replace (#2335); it says what it did.
    if (isOlderRelease(hello.codegraph, expectedVersion)) return 'older-version';
    // Any other: don't poll; the caller serves in-process so we never run stale-vs-new.
    process.stderr.write(
      `[CodeGraph MCP] Found a server on ${socketPath} but version (${hello.codegraph}) ` +
      `differs from ours (${expectedVersion}); serving this session in-process.\n`
    );
    return 'version-mismatch';
  }
  logAttachedDaemon(socketPath, hello);
  sendClientHello(socket, launchDir, focus);
  return socket;
}

/**
 * Tell the server our pids, launch directory and session scope right after we
 * verify its hello. The pids let its liveness sweep reap this client if our
 * process dies without the socket ever signalling close (the Windows
 * named-pipe hazard); the launch directory fixes the session's
 * repo anchor, so without it every call on this session is answered with
 * guidance to restart it. The scope is this client's own: its `--focus`
 * directories, and its raw CODEGRAPH_MCP_TOOLS, which is sent even when empty
 * so the server never answers this client from the environment of whichever
 * client started it. Sent before any piped bytes so it's always the server's first line from
 * us; a write failure here is harmless (the server just falls back to the
 * socket-close lifecycle). `hostPid` mirrors the PPID watchdog: the threaded
 * host pid if set, else our own parent (the host, on a no-relaunch bundle).
 * Never send the `control` marker from an agent session: the server takes a hello with it and no `launchDir`
 * for a control client (daemon.ts ClientPeers.control), which may send codegraph/indexWrite.
 */
function sendClientHello(socket: net.Socket, launchDir?: string, focus?: readonly string[]): void {
  const clientHello: DaemonClientHello = {
    codegraph_client: 1,
    pid: process.pid,
    hostPid: parseHostPpid(process.env[HOST_PPID_ENV]) ?? EARLY_PPID,
    ...(launchDir !== undefined ? { launchDir } : {}),
    focus: [...(focus ?? [])],
    tools: process.env.CODEGRAPH_MCP_TOOLS ?? '',
  };
  try { socket.write(JSON.stringify(clientHello) + '\n'); } catch { /* best-effort */ }
}

type JsonRpc = Record<string, unknown>;

/** Dependencies the local-handshake proxy needs, injected by MCPServer (which
 *  owns the daemon-spawn machinery and the engine factory). */
export interface LocalHandshakeDeps {
  /** Probe (replacing a server of an older release, #2335) → spawn → retry →
   *  hello-verify; resolves a connected server socket, or null when the server
   *  path is genuinely unavailable (→ in-process fallback). */
  getDaemonSocket(): Promise<net.Socket | null>;
  /** Lazily create an in-process engine — used only while the server is
   *  unreachable, preserving the "a broken server never wedges a session"
   *  guarantee. It is rootless, with no index builder, so read-only (`new MCPEngine()`):
   *  it never writes an index (no seed of a worktree's index, no cold build, no
   *  registry entry, no `codegraph.lock` or writer slot), so it holds no lock the
   *  server needs. Called again
   *  whenever the previous engine was retired (#2277). */
  makeEngine(): MCPEngine;
  /** The directory this session was launched in. The fallback's repo anchor is
   *  resolved from it, so in-process calls answer for exactly the repository
   *  the server would have answered for. */
  launchDir: string;
  /** The session's `--focus` directories, normalised and relative to the repository root (`normaliseFocusArgs`); none when omitted. The fallback keeps them as the server does for a hello (`sessionFocusEntries`). */
  focus?: readonly string[];
}

/**
 * Local-handshake proxy (the cold-start fix).
 *
 * Answers `initialize` + `tools/list` from STATIC constants the instant the
 * client asks (the list is filtered by THIS client's CODEGRAPH_MCP_TOOLS, which
 * the hello also carries so the server's call gate agrees with it) — tools register in ~process-startup time instead of waiting
 * ~600ms for the daemon to spawn+bind, which is what produced the "No such tool
 * available" race that made headless agents flail into grep/Read. Tool CALLS are
 * forwarded to the shared daemon (connected in the background); the daemon's
 * response to the forwarded `initialize` is suppressed (the client already got
 * the local one). If the daemon never comes up (version mismatch / spawn fail),
 * a lazily-created in-process engine serves the calls — so the handshake speedup
 * never costs the old fall-back-to-direct robustness.
 *
 * Serving in-process is not for the rest of the session (#2277): it is
 * read-only (no sync, not even for `fresh: true`; it never seeds, builds or
 * registers an index, and every index it opens is opened read-only) and it
 * duplicates work the server does for every session. The proxy retries the
 * server with backoff, stops the fallback engine once one answers, and proxies
 * again. In-process calls go through the same dispatch the server's sessions
 * use ({@link dispatchToolCall}: tool-name checks, repo-anchor guard, index
 * admission), with this process's own focus and tool allowlist, so a degraded
 * session answers for the same repository, the same focus and the same tools,
 * and asks for the same `projectPath`.
 */
export async function runLocalHandshakeProxy(deps: LocalHandshakeDeps): Promise<void> {
  // The proxy is long-lived and can serve fallback tool calls in-process. Match
  // direct/daemon mode by killing this launcher if its main thread wedges, so an
  // MCP host retry cannot accumulate abandoned `serve --mcp` wrapper processes.
  const livenessWatchdog: WatchdogHandle | null = installMainThreadWatchdog();
  let daemonStatus: 'connecting' | 'ready' | 'failed' = 'connecting';
  let daemonSocket: net.Socket | null = null;
  let clientInitId: unknown = undefined;   // suppress the daemon's reply to the forwarded initialize
  let clientInitLine: string | undefined;  // replayed to a daemon that comes up mid-session (#2277)
  // Telemetry attribution for the in-process fallback only — calls routed to
  // the daemon are counted by the daemon's own session (which receives the
  // forwarded initialize, clientInfo included), never double-counted here.
  let telemetryClient: ClientInfo | undefined;
  const pending: string[] = [];            // client lines buffered until the daemon resolves
  let engine: MCPEngine | null = null;
  // The repo anchor of this session's launch dir, resolved on the first call
  // served in-process and kept once it has resolved. A failed resolution is NOT
  // kept: the next call resolves again, so one transient failure cannot disable
  // every later call for the life of the process, and the failure is logged
  // once. A call that finds no anchor is answered with the guard's "restart the
  // session" guidance.
  let anchor: Promise<RepoAnchor> | null = null;
  let anchorFailureLogged = false;
  const getAnchor = async (): Promise<RepoAnchor | null> => {
    const attempt = (anchor ??= resolveRepoAnchor(deps.launchDir));
    try {
      return await attempt;
    } catch (err) {
      if (anchor === attempt) anchor = null;
      if (!anchorFailureLogged) {
        anchorFailureLogged = true;
        process.stderr.write(
          `[CodeGraph MCP] Could not resolve the repository of ${deps.launchDir} (${err instanceof Error ? err.message : String(err)}); ` +
          'in-process calls get restart guidance until it resolves, and each call tries again.\n'
        );
      }
      return null;
    }
  };
  // Calls being served in-process; the engine is only ever stopped after they finish.
  const localCalls = new Set<Promise<void>>();
  // Engines retired but not yet stopped; shutdown() waits for them too.
  const retiring = new Set<MCPEngine>();
  let shuttingDown = false;
  const retryBaseMs = parseDelayMs(process.env.CODEGRAPH_DAEMON_RETRY_MS, DEFAULT_DAEMON_RETRY_MS);
  const retryMaxMs = Math.max(retryBaseMs, parseDelayMs(process.env.CODEGRAPH_DAEMON_RETRY_MAX_MS, DEFAULT_DAEMON_RETRY_MAX_MS));
  let retryDelayMs = retryBaseMs;
  let retryTimer: NodeJS.Timeout | null = null;
  let attachedAt = 0;
  // Requests forwarded to the daemon and not yet answered, keyed by JSON-RPC id.
  // If the daemon dies mid-session (#662), these would otherwise hang forever;
  // we re-serve them in-process so the host always gets a reply.
  const inflight = new Map<unknown, string>();
  // Explore call history for the ONE host connection this proxy serves (CG-17).
  // Only the daemon-unavailable fallback below uses it; when the daemon is up,
  // the tracking happens on the daemon's own MCPSession.
  const exploreSession = new ExploreSessionState();
  // The fallback is still one MCP client session. Keep its one-time warnings
  // local just as MCPSession does when the machine server answers.
  const indexVersionWarnings = new IndexVersionWarningState();
  const recordDaemonWarning = (requestLine: string | undefined, response: JsonRpc): void => {
    if (!requestLine) return;
    const result = response.result as { content?: Array<{ type?: unknown; text?: unknown }> } | undefined;
    const first = result?.content?.[0];
    if (first?.type !== 'text' || typeof first.text !== 'string') return;
    if (!first.text.startsWith(INDEX_VERSION_WARNING_PREFIX)) return;

    let request: JsonRpc;
    try { request = JSON.parse(requestLine) as JsonRpc; } catch { return; }
    const params = request.params as {
      arguments?: { projectPath?: unknown };
    } | undefined;
    // Every call names its project (the server has no default one), so a
    // warning always belongs to the root that path resolves to.
    const requestedPath = params?.arguments?.projectPath;
    if (typeof requestedPath !== 'string') return;
    const root = findNearestCodeGraphRoot(requestedPath);
    if (!root) return;
    indexVersionWarnings.claim(root);
  };
  const trackInflight = (line: string): void => {
    try {
      const m = JSON.parse(line) as JsonRpc;
      if (m && m.id !== undefined && typeof m.method === 'string' && m.method !== 'initialize') {
        inflight.set(m.id, line);
      }
    } catch { /* unparseable — nothing we could re-serve anyway */ }
  };

  const writeClient = (obj: JsonRpc | string): void => {
    try { process.stdout.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n'); } catch { /* host gone */ }
  };
  const shutdown = (): void => {
    if (shuttingDown) return; shuttingDown = true;
    try { livenessWatchdog?.stop(); } catch { /* ignore */ }
    if (retryTimer) clearTimeout(retryTimer);
    try { daemonSocket?.destroy(); } catch { /* ignore */ }
    // Exit once every engine has stopped, a retiring one included: exiting while
    // a query worker is still starting up can crash the process on Windows (see
    // QueryPool.destroy). The backstop
    // bounds a stop that never settles; it stays ref'd so the process lives
    // until one of the two exits it.
    setTimeout(() => {
      process.stderr.write(`[CodeGraph MCP] In-process engine did not stop within ${SHUTDOWN_BACKSTOP_MS}ms; exiting anyway.\n`);
      process.exit(0);
    }, SHUTDOWN_BACKSTOP_MS);
    const stopping = [engine, ...retiring].map((e) => Promise.resolve().then(() => e?.stop()));
    void Promise.allSettled(stopping).then(() => process.exit(0));
  };
  // Resolves the engine a call was started on, so a call in flight while the
  // engine is being retired still finishes on it.
  const ensureEngine = (): MCPEngine => {
    // shutdown() stops only the engines it can see; never start one after it.
    if (!engine && shuttingDown) throw new Error('codegraph is shutting down');
    if (!engine) engine = deps.makeEngine();
    return engine;
  };
  // Stop the in-process engine once the calls it is serving have answered.
  const retireEngine = async (): Promise<void> => {
    const retired = engine;
    engine = null;
    if (retired) retiring.add(retired);
    try {
      await Promise.allSettled([...localCalls]);
      try { await retired?.stop(); } catch { /* best-effort */ }
    } finally {
      if (retired) retiring.delete(retired);
    }
  };
  // Daemon-unavailable fallback: serve a client message in-process.
  const handleLocally = (line: string): Promise<void> => {
    const call = serveLocally(line);
    localCalls.add(call);
    const done = (): void => { localCalls.delete(call); };
    call.then(done, done);
    return call;
  };
  const serveLocally = async (line: string): Promise<void> => {
    let msg: JsonRpc; try { msg = JSON.parse(line) as JsonRpc; } catch { return; }
    const id = msg.id;
    if (msg.method === 'tools/call' && id !== undefined) {
      try {
        // The same dispatch the server's sessions run (MCPSession.handleToolsCall):
        // tool-name checks, the required-projectPath and repo-anchor guard, then
        // the handler. Only the reply and telemetry are the proxy's own.
        // The engine is resolved before the anchor is awaited: a call in flight
        // while the engine is retired finishes on the engine it started on.
        const handler = ensureEngine().getToolHandler();
        const anchor = await getAnchor();
        const outcome = await dispatchToolCall({
          handler,
          anchor,
          exploreSession,
          // This process's own scope, which the server would have had from the
          // client hello: its repo-relative focus entries, and this client's
          // CODEGRAPH_MCP_TOOLS.
          focus: sessionFocusEntries(deps.focus),
          toolAllowlist: parseToolAllowlist(process.env.CODEGRAPH_MCP_TOOLS ?? ''),
          indexVersionWarnings,
          params: msg.params,
        });
        if ('error' in outcome) {
          writeClient({ jsonrpc: '2.0', id, error: outcome.error });
        } else {
          writeClient({ jsonrpc: '2.0', id, result: outcome.result });
          getTelemetry().recordUsage('mcp_tool', outcome.toolName, !outcome.result.isError, telemetryClient);
        }
      } catch (err) {
        writeClient({ jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
      }
    } else if (msg.method === 'ping' && id !== undefined) {
      writeClient({ jsonrpc: '2.0', id, result: {} });
    } else if (id !== undefined && msg.method !== 'initialize') {
      // A request we can't serve in-process (and the daemon is gone) — answer
      // with an error rather than let the host hang on a reply that won't come.
      writeClient({ jsonrpc: '2.0', id, error: { code: -32603, message: 'CodeGraph daemon unavailable' } });
    }
    // initialize already answered locally; notifications (initialized) need no reply.
  };
  const routeToDaemon = (line: string): void => {
    if (daemonStatus === 'ready' && daemonSocket) {
      trackInflight(line);
      if (process.env.CODEGRAPH_MCP_DEBUG) process.stderr.write(`[mcp-debug] proxy->daemon ${line.slice(0, 80)}\n`);
      try { daemonSocket.write(line.endsWith('\n') ? line : line + '\n'); } catch { /* close path */ }
    } else if (daemonStatus === 'failed') {
      void handleLocally(line);
    } else {
      if (process.env.CODEGRAPH_MCP_DEBUG) process.stderr.write(`[mcp-debug] proxy-buffer(${daemonStatus}) ${line.slice(0, 80)}\n`);
      pending.push(line);
    }
  };

  // ---- client (stdin) ----
  let stdinBuf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    // Nothing is served once shutdown starts: a call now could start an engine
    // shutdown() never sees, and the process exits as soon as the others stop.
    if (shuttingDown) return;
    stdinBuf += chunk;
    let idx: number;
    while ((idx = stdinBuf.indexOf('\n')) !== -1) {
      const line = stdinBuf.slice(0, idx).trim();
      stdinBuf = stdinBuf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpc; try { msg = JSON.parse(line) as JsonRpc; } catch { routeToDaemon(line); continue; }
      if (msg.method === 'initialize') {
        clientInitId = msg.id;
        clientInitLine = line;
        const initParams = (msg.params ?? {}) as { clientInfo?: { name?: unknown; version?: unknown } };
        if (initParams.clientInfo) {
          telemetryClient = {
            name: typeof initParams.clientInfo.name === 'string' ? initParams.clientInfo.name : undefined,
            version: typeof initParams.clientInfo.version === 'string' ? initParams.clientInfo.version : undefined,
          };
        }
        writeClient({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: initializeInstructions(SERVER_INSTRUCTIONS) } });
        routeToDaemon(line); // prime the server's session with the client's initialize (its reply is suppressed below)
      } else if (msg.method === 'tools/list') {
        writeClient({ jsonrpc: '2.0', id: msg.id, result: { tools: getStaticTools() } });
      } else if (msg.method === 'resources/list') {
        // No resources exposed — answer the probe locally so it never reaches
        // the daemon as an unhandled method and logs `-32601`. (#621)
        writeClient({ jsonrpc: '2.0', id: msg.id, result: { resources: [] } });
      } else if (msg.method === 'resources/templates/list') {
        writeClient({ jsonrpc: '2.0', id: msg.id, result: { resourceTemplates: [] } });
      } else if (msg.method === 'prompts/list') {
        writeClient({ jsonrpc: '2.0', id: msg.id, result: { prompts: [] } });
      } else if (msg.method === 'server/discover' && msg.id !== undefined) {
        // Newer clients (Antigravity 2.5) probe this before `initialize` and wait
        // for the answer. We don't implement it; Method-not-found is what sends
        // them on to `initialize`. Answer locally — forwarded, it waited on the
        // daemon connection and was lost if the client closed stdin first. (#2084)
        writeClient({ jsonrpc: '2.0', id: msg.id, error: { code: ErrorCodes.MethodNotFound, message: 'Method not found: server/discover' } });
      } else {
        routeToDaemon(line);
      }
    }
  });
  // Shut down when stdin ends/closes — and also on a stdin `'error'`, which a
  // socket-backed stdin (the VS Code stdio shape) can emit on client death
  // instead of a clean close; destroying the stream stops a hung fd from
  // busy-spinning the event loop (#799).
  treatStdinFailureAsShutdown(shutdown);
  // A host can also stop reading our output while it keeps stdin open and
  // stays alive: shut down the same way, which closes only this session's
  // daemon connection and stops its own engines (#2991).
  treatStdoutFailureAsShutdown(shutdown);
  startPpidWatchdogNoSocket(shutdown);
  // Backstop for a launch abandoned before any of the above can see it: killed
  // launcher + held-open pipes + reparent that beat the EARLY_PPID capture
  // (#1185). A server that never receives a single byte isn't serving anyone.
  // Armed after the stdin 'data' consumer above so no bytes are emitted while
  // only the backstop's listener exists.
  armStartupHandshakeTimeout(() => {
    process.stderr.write(
      '[CodeGraph MCP] No MCP traffic since startup; assuming an abandoned launch and shutting down (#1185). ' +
      'Tune with CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS (0 disables).\n'
    );
    shutdown();
  });

  // ---- daemon connection (background) ----
  const connectDaemon = async (): Promise<net.Socket | null> => {
    let socket: net.Socket | null = null;
    try { socket = await deps.getDaemonSocket(); } catch { socket = null; }
    // `socket.destroyed`: the connect-window error guard above can absorb an
    // 'error' that already destroyed the socket before we got here (#974) — treat
    // a dead socket as "no daemon" so we cleanly fall back to the in-process engine.
    if (socket && (socket.destroyed || shuttingDown)) {
      try { socket.destroy(); } catch { /* ignore */ }
      socket = null;
    }
    return socket;
  };
  // Every buffered call binds to the engine now, so a later retirement waits for all of them.
  const serveBufferedLocally = (): void => {
    for (const line of pending.splice(0)) void handleLocally(line);
  };
  const scheduleDaemonRetry = (): void => {
    if (shuttingDown || retryTimer || retryBaseMs <= 0) return;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, retryMaxMs);
    retryTimer = setTimeout(() => { retryTimer = null; void retryDaemon(); }, delay);
    retryTimer.unref?.();
  };
  const retryDaemon = async (): Promise<void> => {
    if (shuttingDown || daemonStatus !== 'failed') return;
    const socket = await connectDaemon();
    if (shuttingDown) return;
    if (socket) {
      process.stderr.write('[CodeGraph MCP] Shared daemon reachable; proxying this session to it instead of serving in-process.\n');
      attachDaemon(socket, true);
      // The fallback engine is read-only and holds no lock: let the calls it is
      // serving finish, then stop it.
      void retireEngine();
      return;
    }
    scheduleDaemonRetry();
  };

  const attachDaemon = (socket: net.Socket, replayInitialize: boolean): void => {
    daemonSocket = socket;
    daemonStatus = 'ready';
    attachedAt = Date.now();
    let sockBuf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      sockBuf += chunk;
      let idx: number;
      while ((idx = sockBuf.indexOf('\n')) !== -1) {
        const line = sockBuf.slice(0, idx);
        sockBuf = sockBuf.slice(idx + 1);
        if (!line.trim()) continue;
        let resp: JsonRpc | null = null;
        try { resp = JSON.parse(line) as JsonRpc; } catch { /* not JSON — relay verbatim */ }
        if (process.env.CODEGRAPH_MCP_DEBUG) process.stderr.write(`[mcp-debug] daemon->proxy ${line.slice(0, 80)}\n`);
        if (resp && resp.id !== undefined && ('result' in resp || 'error' in resp)) {
          recordDaemonWarning(inflight.get(resp.id), resp);
          inflight.delete(resp.id); // answered — no longer in flight
          // Suppress the daemon's reply to the initialize we forwarded to prime it
          // (the client already got the local handshake response).
          if (clientInitId !== undefined && resp.id === clientInitId) continue;
        }
        writeClient(line);
      }
    });
    // The server going away does NOT end the session (#662). The server can stop
    // while a session is attached (an upgrade, `codegraph daemon --stop`, a
    // crash); if we exited here, this host would silently lose CodeGraph and any
    // in-flight request would hang. Instead, fall back to the in-process engine
    // until a server answers again, and re-serve whatever the dead server never
    // answered.
    const onDaemonLost = (): void => {
      if (shuttingDown || daemonSocket !== socket) return; // host teardown, or already handled
      daemonStatus = 'failed';
      daemonSocket = null;
      try { socket.destroy(); } catch { /* ignore */ }
      process.stderr.write(
        `[CodeGraph MCP] Shared daemon connection lost; serving this session in-process (degraded), re-serving ${inflight.size} in-flight request(s).\n`
      );
      const orphaned = [...inflight.values()];
      inflight.clear();
      for (const line of orphaned) void handleLocally(line);
      // A link that stayed up past the longest wait starts the backoff over; one
      // that keeps dropping right after it attaches keeps backing off.
      if (Date.now() - attachedAt >= retryMaxMs) retryDelayMs = retryBaseMs;
      scheduleDaemonRetry();
    };
    socket.on('close', onDaemonLost);
    socket.on('error', onDaemonLost);
    // A daemon that came up mid-session has never seen this client: prime its
    // session with the client's own initialize, whose reply is suppressed
    // above like the first one.
    if (replayInitialize && clientInitLine !== undefined) {
      try { socket.write(clientInitLine + '\n'); } catch { /* close path */ }
    }
    for (const line of pending) {
      trackInflight(line);
      if (process.env.CODEGRAPH_MCP_DEBUG) process.stderr.write(`[mcp-debug] proxy-flush ${line.slice(0, 80)}\n`);
      try { socket.write(line + '\n'); } catch { /* ignore */ }
    }
    pending.length = 0;
  };

  const socket = await connectDaemon();
  if (socket) {
    attachDaemon(socket, false);
  } else if (!shuttingDown) {
    daemonStatus = 'failed';
    process.stderr.write('[CodeGraph MCP] Shared daemon unavailable; serving this session in-process (degraded).\n');
    serveBufferedLocally();
    scheduleDaemonRetry();
  }

  await new Promise<void>(() => { /* stdin keeps the loop alive; exit via shutdown() */ });
}

/** PPID watchdog for the local-handshake proxy (#277): shuts the proxy down when
 *  its host process is gone. There is no socket to close here (the caller's
 *  shutdown handles teardown). */
function startPpidWatchdogNoSocket(onDeath: () => void): void {
  const pollMs = parsePollMs(process.env.CODEGRAPH_PPID_POLL_MS);
  if (pollMs <= 0) return;
  // Baseline from the CLI entry's earliest capture, not process.ppid here —
  // a launcher killed during our first ~100ms would otherwise leave the
  // baseline at 1 and blind the divergence check forever (#1185).
  const originalPpid = EARLY_PPID;
  const hostPpid = parseHostPpid(process.env[HOST_PPID_ENV]);
  const timer = setInterval(() => {
    const reason = supervisionLostReason({
      originalPpid,
      currentPpid: process.ppid,
      hostPpid,
      isAlive: isProcessAliveLocal,
    });
    if (reason) {
      process.stderr.write(`[CodeGraph MCP] Parent process exited (${reason}); shutting down.\n`);
      onDeath();
    }
  }, pollMs);
  timer.unref?.();
}

/**
 * Read one CRLF/LF-terminated JSON line from the socket, parse it as the
 * server hello, and return it. Bounded to {@link MAX_HELLO_LINE_BYTES} so a
 * malicious or broken peer can't OOM us. Times out after `timeoutMs` (3s by
 * default) — a healthy daemon sends hello immediately on accept.
 */
function readHelloLine(socket: net.Socket, timeoutMs: number = DAEMON_HELLO_TIMEOUT_MS): Promise<DaemonHello> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      clearTimeout(timer);
    };
    const onData = (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const idx = buffer.indexOf('\n');
      if (idx === -1) {
        if (buffer.length > MAX_HELLO_LINE_BYTES) {
          cleanup();
          reject(new Error('daemon hello line exceeded size limit'));
        }
        return;
      }
      const line = buffer.slice(0, idx);
      // Re-emit anything past the newline so the pipe-stage sees it.
      const tail = buffer.slice(idx + 1);
      cleanup();
      if (tail.length > 0) {
        // Push back via unshift — Node's net.Socket supports it on readable streams.
        socket.unshift(tail);
      }
      try {
        const parsed = JSON.parse(line) as DaemonHello;
        if (typeof parsed.codegraph !== 'string' || typeof parsed.pid !== 'number') {
          reject(new Error('daemon hello missing required fields'));
          return;
        }
        resolve(parsed);
      } catch (err) {
        reject(new Error(`daemon hello not JSON: ${err instanceof Error ? err.message : String(err)}`));
      }
    };
    const onError = (err: Error) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error('daemon closed connection before hello')); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for daemon hello'));
    }, timeoutMs);
    timer.unref?.();
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

function parsePollMs(raw: string | undefined): number {
  return parseDelayMs(raw, DEFAULT_PPID_POLL_MS);
}

/** A non-negative millisecond env value; unset or malformed gives `fallback`. */
function parseDelayMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return fallback;
  return Math.floor(parsed);
}

function parseHostPpid(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 1) return null;
  return parsed;
}

function isProcessAliveLocal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EPERM') return true;
    return false;
  }
}
