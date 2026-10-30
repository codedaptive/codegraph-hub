/**
 * MCP shared engine — the heavyweight, *shared* state for an MCP server:
 * the project's {@link CodeGraph} instance, file watcher, and the
 * {@link ToolHandler} cache for cross-project queries, and the housekeeping
 * pass that tears down registered projects whose worktree is gone, lets go of
 * explicit projects whose index another process removed, and retires the
 * default project once its directory or index is gone.
 *
 * One engine, many sessions:
 * - direct mode (single stdio session) instantiates one engine + one session;
 * - daemon mode instantiates one engine and a new session per socket
 *   connection. Every session reads from the same SQLite WAL and the same
 *   inotify watch set — that's the entire point of issue #411.
 */

import * as os from 'os';
import * as path from 'path';
import type CodeGraph from '../index';
import { canonicalProjectRoot, isInitialized, resolveServerRoot } from '../directory';
import { ToolHandler } from './tools';
import { WslSharedIndexError } from '../db/wsl-shared-index';
import { DatabaseOpenError, isDatabaseOpenFailure } from '../db/open-error';
import type { NodeSqliteUnavailableError } from '../db/node-sqlite';
import { assertNoRebuild, releaseWriterLock, tryAcquireWriterLock, writerLockHeldMessage } from './writer-lock';
import { QueryPool, resolvePoolSize } from './query-pool';
import { endFreshnessMeasurements } from './index-freshness';
import { acquireProject, ProjectLease } from './project-lifecycle';
import { EngineHousekeeping } from '../extensions/host/worktree-lifecycle/housekeeping';

// Lazy-load the heavy CodeGraph chain (sqlite + query/graph/context layers) OFF
// the MCP startup path. It's only needed once a tool actually opens a project —
// not to answer initialize/tools-list — so deferring it lets `serve --mcp` (and
// the daemon it spawns) bind + register tools in ~Node-startup time instead of
// ~800ms, closing the "No such tool available" cold-start race that made headless
// agents flounder. require() is sync + cached on the CommonJS build.
const loadCodeGraph = (): typeof import('../index').default =>
  (require('../index') as typeof import('../index')).default;

/** How often the per-tool-call retry may re-run the sub-project down-scan. */
const RETRY_SUBSCAN_TTL_MS = 5_000;

/**
 * Why the default project failed to open, when a tool call should say so
 * rather than "no project loaded": the Windows/WSL shared index (#995), or an
 * index that exists but SQLite could not open, or no node:sqlite at all.
 */
function reportableOpenFailure(err: unknown): WslSharedIndexError | DatabaseOpenError | NodeSqliteUnavailableError | null {
  return err instanceof WslSharedIndexError || isDatabaseOpenFailure(err) ? err : null;
}

export interface MCPEngineOptions {
  /** Serve existing index contents without syncing, watching, or claiming a writer slot. */
  readOnly?: boolean;
  /**
   * Whether to start the file watcher when initializing. Daemon and direct
   * modes both want this true; tests may set it false to keep the engine
   * cheap. Honors {@link watchDisabledReason} regardless.
   */
  watch?: boolean;
  /**
   * Whether to off-load read-tool dispatch to a worker-thread pool. Both daemon
   * and direct sessions can issue concurrent calls on one event loop.
   * `CODEGRAPH_QUERY_POOL_SIZE=0` disables it in either mode.
   */
  queryPool?: boolean;
  /**
   * Worker cap when `CODEGRAPH_QUERY_POOL_SIZE` is unset. A direct (single-client)
   * session sets a small cap so every session doesn't hold one worker per core;
   * the shared daemon leaves it unset and scales with the machine.
   */
  queryPoolDefaultMax?: number;
  /**
   * Project root whose writer slot must be claimed synchronously before this
   * engine can open the graph. Used by proxy fallback to fence catch-up sync,
   * not just the later file watcher.
   */
  writerLockRoot?: string;
}

/**
 * Shared MCP engine. Thread-safe in the sense that multiple sessions can
 * call its methods concurrently — internally it serializes initialization
 * through a single promise so multiple sessions racing each other on first
 * connect never double-open the SQLite file.
 */
export class MCPEngine {
  private cg: CodeGraph | null = null;
  private toolHandler: ToolHandler;
  // Project root we resolved to. Null until `ensureInitialized` succeeds
  // (or null forever if no .codegraph/ ever turned up — that's a valid
  // state for the engine, since cross-project queries still work).
  private projectPath: string | null = null;
  // canonicalProjectRoot of the open default project, taken when it opened:
  // once its directory is gone, canonicalizing the path again no longer
  // resolves symlinks (macOS /var vs /private/var), so it would not match the
  // registry's or the handler's spelling. Null while no default is open.
  private defaultRoot: string | null = null;
  // The canonical default root this engine retired (its directory or index
  // went away), until it is adopted again. While set, the only default the
  // engine may open is this same root, once it has an index again: never a
  // parent checkout's index found by walking up from it.
  private retiredRoot: string | null = null;
  // The retirement in progress, shared by every caller that asks for it.
  private retirement: Promise<void> | null = null;
  // Set on first `ensureInitialized` so subsequent sessions don't redo work.
  private initPromise: Promise<void> | null = null;
  // Throttle for the retry path's sub-project down-scan (#1606) — the scan is
  // bounded but shouldn't run on every tool call in the no-default state.
  private lastRetrySubScanAt = 0;
  // The default-root refusal last written to stderr, so the retry on every
  // tool call doesn't repeat it.
  private loggedRootRefusal: string | null = null;
  private watcherStarted = false;
  /** Set when this engine holds writer.pid (#1740). */
  private writerLockRoot: string | null = null;
  // Retained synchronization ownership for each cached explicit project: one
  // lease per lifecycle open. acquireProject hands every open of a root the
  // same CodeGraph while it is held, so one graph can carry two leases: a
  // call that reopens a root while the handler's releaseProjectRoot waits for
  // in-flight calls takes a second one before the first is released. Each
  // release returns exactly one, so neither is dropped or leaked.
  private explicitProjects = new Map<CodeGraph, ProjectLease[]>();
  private defaultLease: ProjectLease | null = null;
  private opts: Required<Omit<MCPEngineOptions, 'writerLockRoot' | 'queryPoolDefaultMax'>> & Pick<MCPEngineOptions, 'queryPoolDefaultMax'>;
  private closed = false;
  private stopPromise: Promise<void> | null = null;
  // Off-loop read-tool pool. Workers each hold their own WAL read connections;
  // sessions without a default index open projects lazily via projectPath.
  private queryPool: QueryPool | null = null;
  // The housekeeping timer and pass, and the roots query-pool workers may hold.
  private housekeeping: EngineHousekeeping;

  constructor(opts: MCPEngineOptions = {}) {
    this.opts = { readOnly: opts.readOnly ?? false, watch: opts.watch ?? true, queryPool: opts.queryPool ?? false, queryPoolDefaultMax: opts.queryPoolDefaultMax };
    this.housekeeping = new EngineHousekeeping({
      releaseProjectRoot: (root) => this.releaseProjectRoot(root),
      cachedProjectRoots: () => this.toolHandler.cachedProjectRoots(),
      openDefaultRoot: () => (this.toolHandler.hasDefaultCodeGraph() ? this.defaultRoot : null),
      readOnly: this.opts.readOnly,
    });
    this.toolHandler = new ToolHandler(null);
    this.toolHandler.setProjectLifecycle({
      open: (root, open) => {
        // Explicit projects and read-only fallbacks also hold SQLite handles.
        // Fence them before opening, just like the default daemon project.
        assertNoRebuild(root);
        if (this.opts.queryPool) this.housekeeping.notePoolOpenedRoot(root);
        if (this.opts.readOnly) return loadCodeGraph().openSync(root, { readOnly: true });
        if (!this.opts.watch) return open();
        const lease = acquireProject(root, open, this.watchOptions());
        const leases = this.explicitProjects.get(lease.cg);
        if (leases) leases.push(lease);
        else this.explicitProjects.set(lease.cg, [lease]);
        return lease.cg;
      },
      // Every lease on one graph shares its project's catch-up gate.
      activate: (cg) => this.explicitProjects.get(cg)?.[0]?.ready() ?? Promise.resolve(),
      release: (cg) => this.releaseExplicitProject(cg),
    });
    // A tool call found the default project's database replaced on disk (a
    // `codegraph index` rebuild) and reopened it (#1902). Reconcile the new
    // file with the usual catch-up — `sync()` serializes on the index mutex,
    // so it never overlaps an in-flight watcher sync. Only when this engine is
    // watching, i.e. it is the project's writer: a read-only engine (writer
    // lock held elsewhere, watching disabled) must not start writing.
    this.toolHandler.setOnDatabaseReopened((cg) => {
      if (cg === this.cg && cg.isWatching()) this.catchUpSync(true);
    });
    if (opts.writerLockRoot && !this.opts.readOnly) {
      assertNoRebuild(opts.writerLockRoot);
      const writer = tryAcquireWriterLock(opts.writerLockRoot, 'fallback');
      if (writer.kind === 'taken') {
        throw new Error(writerLockHeldMessage(writer.existing, writer.pidPath));
      }
      this.writerLockRoot = opts.writerLockRoot;
    }
    // Housekeeping (src/extensions/host/worktree-lifecycle/housekeeping.ts):
    // a timer, stopped in stop(); releasing the default project retires it
    // (see releaseProjectRoot).
    this.housekeeping.start();
  }

  /**
   * One housekeeping pass, now, whatever CODEGRAPH_HOUSEKEEPING_INTERVAL_MS
   * says (the timer runs the same pass): the registry sweep (skipped on a
   * read-only engine), then the release, through {@link releaseProjectRoot},
   * of every project this engine holds whose directory or
   * `.codegraph/codegraph.db` is gone; for the default project that is its
   * retirement. Never rejects. A no-op once the engine is stopped.
   */
  async runHousekeepingTick(): Promise<void> {
    if (this.closed) return;
    await this.housekeeping.runPass();
  }

  /** Whether canonical `root` is this engine's open default project. */
  private isDefaultRoot(root: string): boolean {
    return this.defaultRoot !== null && this.defaultRoot === root && this.toolHandler.hasDefaultCodeGraph();
  }

  /** Record `root` as the open default project (its canonical spelling, taken now). */
  private noteDefaultOpened(root: string): void {
    this.defaultRoot = canonicalProjectRoot(root);
    this.retiredRoot = null;
  }

  /**
   * Where a default-project search may start. Normally `searchFrom`. After a
   * retirement, only the retired root itself, and only once it has an index
   * again (null otherwise): a walk up from it would adopt the index of a
   * checkout above it, and a scan below it a sub-project, neither of which is
   * the project this server was serving.
   */
  private defaultSearchStart(searchFrom: string): string | null {
    if (this.retirement) return null;
    if (this.retiredRoot === null) return searchFrom;
    return isInitialized(this.retiredRoot) ? this.retiredRoot : null;
  }

  /** Whether a resolved `root` may become the default: after a retirement, only the retired root. */
  private mayAdoptDefault(root: string): boolean {
    return this.retiredRoot === null || canonicalProjectRoot(root) === this.retiredRoot;
  }

  /**
   * Start the worker-thread query pool after resolving the default project
   * (which may be absent). Honors `CODEGRAPH_QUERY_POOL_SIZE`; best-effort:
   * if workers can't spawn on this platform the ToolHandler keeps serving reads
   * in-process, so the pool can only help, never break, tool calls.
   */
  private maybeStartPool(root: string | null): void {
    if (this.opts.readOnly || !this.opts.queryPool || this.queryPool || this.closed) return;
    const envSize = process.env.CODEGRAPH_QUERY_POOL_SIZE;
    let size = resolvePoolSize(envSize, os.cpus().length);
    if ((envSize === undefined || envSize === '') && this.opts.queryPoolDefaultMax !== undefined) {
      size = Math.min(size, this.opts.queryPoolDefaultMax);
    }
    if (size <= 0) {
      process.stderr.write('[CodeGraph MCP] Query pool disabled (CODEGRAPH_QUERY_POOL_SIZE=0); serving reads in-process.\n');
      return;
    }
    try {
      this.queryPool = new QueryPool({ root, size });
      this.toolHandler.setQueryPool(this.queryPool);
      process.stderr.write(`[CodeGraph MCP] Query pool: up to ${size} worker thread(s) for concurrent reads.\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[CodeGraph MCP] Query pool unavailable (${msg}); serving reads in-process.\n`);
      this.queryPool = null;
    }
  }

  /**
   * Convenience for {@link MCPServer} compatibility: pre-seed an explicit
   * project path (from the `--path` CLI flag) without yet opening it. This
   * keeps the synchronous constructor cheap; the actual open happens on the
   * first `ensureInitialized` call.
   */
  setProjectPathHint(projectPath: string): void {
    this.projectPath = projectPath;
    this.toolHandler.setDefaultProjectHint(projectPath);
  }

  /** Whether this engine only reads: no watcher, no sync, no writer slot. */
  isReadOnly(): boolean {
    return this.opts.readOnly;
  }

  /** Project root that the engine resolved on first init (null if none). */
  getProjectPath(): string | null {
    return this.projectPath;
  }

  /** Shared ToolHandler — sessions delegate tool dispatch through this. */
  getToolHandler(): ToolHandler {
    return this.toolHandler;
  }

  /** Whether the default project's CodeGraph is open. */
  hasDefaultCodeGraph(): boolean {
    return this.toolHandler.hasDefaultCodeGraph();
  }

  /**
   * Walk up from `searchFrom` to find the nearest `.codegraph/` and open it.
   * Idempotent: concurrent callers share one in-flight init; subsequent
   * callers after success are no-ops.
   *
   * The original `MCPServer.tryInitializeDefault` carried the same retry-on-
   * subsequent-tool-call semantics; we preserve them by NOT throwing when the
   * search misses (just leaves `cg` null so the next call can retry).
   */
  async ensureInitialized(searchFrom: string): Promise<void> {
    if (this.closed) return;
    if (this.toolHandler.hasDefaultCodeGraph()) return;
    if (this.initPromise) {
      try { await this.initPromise; } catch { /* let caller retry */ }
      return;
    }

    this.initPromise = this.doInitialize(searchFrom).finally(() => {
      this.initPromise = null;
    });
    try {
      await this.initPromise;
    } catch {
      // Init errors are logged inside `doInitialize`; falling through here
      // matches MCPServer's previous "retry on next tool call" behavior.
    }
  }

  /**
   * Synchronous last-resort init used by the per-session retry loop when the
   * background `ensureInitialized` already finished (or failed) and we need
   * to pick up a project that appeared *after* the engine started. After the
   * default project was retired, it only re-adopts that same root, once it
   * has an index again ({@link defaultSearchStart}).
   */
  retryInitializeSync(searchFrom: string): void {
    if (this.closed) return;
    if (this.toolHandler.hasDefaultCodeGraph()) return;
    this.toolHandler.setDefaultProjectHint(searchFrom);
    const start = this.defaultSearchStart(searchFrom);
    if (start === null) return;
    // Same resolution `doInitialize` used: up-walk, then the bounded workspace
    // down-scan (#1606) — this retry is exactly the path that picks up a
    // project (root or child) `codegraph init`'d after the server started. The
    // down-scan is throttled so the persistent no-default state doesn't pay a
    // directory walk on every tool call; the up-walk always runs.
    const scanDue = Date.now() - this.lastRetrySubScanAt >= RETRY_SUBSCAN_TTL_MS;
    const res = resolveServerRoot(start, { subprojectScan: scanDue });
    if (scanDue) {
      this.lastRetrySubScanAt = Date.now();
      if (!res.root) this.toolHandler.setKnownSubprojects(res.candidates, start);
    }
    // An up-walk alone can't clear a refusal the throttled down-scan found.
    if (scanDue || res.refusal) this.noteRootRefusal(res.refusal);
    const resolvedRoot = res.root;
    if (!resolvedRoot || !this.mayAdoptDefault(resolvedRoot)) return;
    if (res.viaSubScan) this.logSubprojectAdoption(searchFrom, resolvedRoot);
    try {
      // Close any previously failed instance to avoid leaking resources.
      if (this.cg) {
        try { this.cg.close(); } catch { /* ignore */ }
        this.cg = null;
      }
      assertNoRebuild(resolvedRoot);
      // Indexes an interrupted bulk load dropped are rebuilt off this thread
      // (#1887); the catch-up and tool calls wait for them.
      this.cg = loadCodeGraph().openSync(resolvedRoot, { readOnly: this.opts.readOnly, deferIndexRecovery: true });
      this.projectPath = resolvedRoot;
      this.noteDefaultOpened(resolvedRoot);
      this.toolHandler.setDefaultCodeGraph(this.cg);
      this.startWatching();
      this.catchUpSync();
      // The pool's workers open the project themselves: start them on a
      // rebuilt one, not racing the rebuild for its write lock.
      const opened = this.cg;
      if (opened?.hasPendingIndexRecovery()) {
        void opened.recoverIndexes().catch(() => { /* reported by the tool call waiting on it */ }).then(() => {
          if (this.cg === opened) this.maybeStartPool(resolvedRoot);
        });
      } else {
        this.maybeStartPool(resolvedRoot);
      }
    } catch (err) {
      // Still failing — caller will try again on the next tool call.
      this.toolHandler.setDefaultOpenFailure(reportableOpenFailure(err));
    }
  }

  /**
   * Close every handle this engine holds on project `root`. For an
   * explicitly opened project: the tool handler's cached connection (through
   * the project lifecycle, so its watcher stops and its writer slot is
   * released), then each query-pool worker's own connection (broadcast to
   * every worker, so a worker still holding a root the handler's cache
   * already dropped closes it too). For the engine's default project: its
   * retirement ({@link retireDefaultProject}), after which the engine has no
   * default project, and then the handler's cached handle on the same root,
   * should it hold one. The housekeeping sweep calls this before it deletes a
   * removed worktree's index, and each housekeeping pass calls it for a held
   * project whose directory or database is gone.
   */
  async releaseProjectRoot(root: string): Promise<void> {
    const canonical = canonicalProjectRoot(root);
    if (this.isDefaultRoot(canonical) || (this.retirement !== null && this.retiredRoot === canonical)) {
      await this.retireDefaultProject();
      // The pool whose workers held the default was destroyed with it; the
      // one started in its place has opened nothing yet.
      await this.toolHandler.releaseProjectRoot(canonical);
      return;
    }
    await this.toolHandler.releaseProjectRoot(canonical);
    await this.queryPool?.releaseProject(canonical);
  }

  /**
   * Retire the default project, whose directory or index is gone: the
   * housekeeping pass found it so, or the registry sweep judged its worktree
   * gone. The engine then serves as one that started where nothing is
   * indexed: a call without `projectPath` gets the no-default-project
   * guidance; explicit projects are unaffected.
   *
   * In order: the query pool and the handler's default are detached at once,
   * so no call that starts from then on reaches either; once no call is in
   * flight, the pool is destroyed (nothing is queued on it by then, so no
   * call is answered "shutting down"); the default graph is let go (its
   * lease, which stops the watcher and, once no other engine in this process
   * holds the root, closes it and frees the writer slot; or unwatch and close
   * without one); the writer slot a proxy fallback claimed for it is
   * released; and, if a pool was in use, one with no default root is started
   * in its place. A later default-project search adopts only this same root,
   * once it has an index again ({@link defaultSearchStart}). Concurrent
   * callers share one retirement. A no-op once the engine is stopping: stop()
   * closes the default itself.
   */
  private retireDefaultProject(): Promise<void> {
    if (this.retirement) return this.retirement;
    if (this.closed) return Promise.resolve();
    const root = this.defaultRoot;
    // Set before the first await, so no default-project search during the
    // retirement can adopt anything.
    this.retiredRoot = root;
    this.retirement = this.detachAndCloseDefault(root).finally(() => { this.retirement = null; });
    return this.retirement;
  }

  private async detachAndCloseDefault(root: string | null): Promise<void> {
    const pool = this.queryPool;
    this.queryPool = null;
    this.toolHandler.setQueryPool(null);
    await this.toolHandler.detachDefaultProject();
    if (pool) await pool.destroy();
    const lease = this.defaultLease;
    const cg = this.cg;
    this.defaultLease = null;
    this.cg = null;
    this.watcherStarted = false;
    this.defaultRoot = null;
    if (lease) {
      await lease.release();
    } else if (cg) {
      cg.unwatch();
      while (cg.isIndexing()) await new Promise((resolve) => setTimeout(resolve, 25));
      cg.close();
    }
    if (this.writerLockRoot) {
      releaseWriterLock(this.writerLockRoot);
      this.writerLockRoot = null;
    }
    process.stderr.write(
      `[CodeGraph MCP] The default project ${root ?? '(unknown)'} is gone (its directory or index was removed); released it. ` +
      'Tool calls without projectPath now have no default project.\n'
    );
    if (pool) this.maybeStartPool(null);
  }

  /**
   * Close everything. Used on graceful daemon shutdown (SIGTERM/idle timeout)
   * and on direct-mode stop. Idempotent. Stops the housekeeping sweep first,
   * so no teardown starts while the engine closes.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.closed = true;
    this.housekeeping.stop();
    if (!this.cg && !this.initPromise && this.explicitProjects.size === 0 && this.writerLockRoot) {
      releaseWriterLock(this.writerLockRoot);
      this.writerLockRoot = null;
    }

    // Detach + terminate the worker pool first so no tool call routes to a
    // worker mid-teardown; outstanding pool calls resolve with graceful guidance.
    // Stopping waits for the workers to end — the pool's, and any
    // `codegraph_status` change count still measuring: the daemon exits right
    // after, and exiting while a worker is still starting up can crash the
    // process.
    this.toolHandler.setQueryPool(null);
    const poolDown = this.queryPool ? this.queryPool.destroy() : Promise.resolve();
    this.queryPool = null;
    const measurementsDown = endFreshnessMeasurements();
    const drained = this.toolHandler.closeAll();
    this.stopPromise = Promise.all([drained, poolDown, measurementsDown]).then(async () => {
      if (this.initPromise) await this.initPromise;
      // A retirement in flight closes the default itself; wait for it to finish.
      if (this.retirement) await this.retirement;
      if (this.defaultLease) {
        await this.defaultLease.release();
        this.defaultLease = null;
        this.writerLockRoot = null;
      } else if (this.cg) {
        this.cg.unwatch();
        while (this.cg.isIndexing()) await new Promise((resolve) => setTimeout(resolve, 25));
        this.cg.close();
      }
      this.cg = null;
      if (this.writerLockRoot) releaseWriterLock(this.writerLockRoot);
      this.writerLockRoot = null;
    });
    return this.stopPromise;
  }

  /**
   * Return one lease on `cg` (the handler releases once per open); the graph
   * closes when its last lease, from every engine in the process, is
   * returned. A graph opened without a lease (read-only, or not watching) is
   * this handler's alone and closes now.
   */
  private releaseExplicitProject(cg: CodeGraph): void | Promise<void> {
    const leases = this.explicitProjects.get(cg);
    const lease = leases?.pop();
    if (leases && leases.length === 0) this.explicitProjects.delete(cg);
    if (lease) return lease.release();
    else cg.close();
  }

  /** Watch options shared by the default project and explicit projects. */
  private watchOptions(): Parameters<CodeGraph['watch']>[0] {
    // Optional override for the debounce window via env var (issue #403).
    // Useful for workspaces with bursty writes (formatter-on-save chains,
    // large generated outputs) where the 2s default fires too often. Clamped
    // to [100ms, 60s]; out-of-range / non-numeric values fall back to the
    // FileWatcher default. We log the active value so it's discoverable.
    const debounceMs = parseDebounceEnv(process.env.CODEGRAPH_WATCH_DEBOUNCE_MS);
    if (debounceMs !== undefined) {
      process.stderr.write(`[CodeGraph MCP] File watcher debounce: ${debounceMs}ms (CODEGRAPH_WATCH_DEBOUNCE_MS)\n`);
    }
    return {
      debounceMs,
      onSyncComplete: (result) => {
        if (result.filesChanged > 0) {
          process.stderr.write(
            `[CodeGraph MCP] Auto-synced ${result.filesChanged} file(s) in ${result.durationMs}ms\n`
          );
        }
      },
      onSyncError: (err) => {
        process.stderr.write(`[CodeGraph MCP] Auto-sync error: ${err.message}\n`);
      },
      onDegraded: (reason) => {
        // Live watching gave up permanently (watch-resource exhaustion or a
        // write lock held past the retry budget). Say so loudly and ONCE — the
        // graph will no longer auto-update, so a long-running MCP session must
        // not keep assuming it's fresh. The reason already names the remedy
        // (`codegraph sync` / git sync hooks).
        process.stderr.write(`[CodeGraph MCP] File watcher degraded — ${reason}\n`);
      },
    };
  }

  private async doInitialize(searchFrom: string): Promise<void> {
    this.toolHandler.setDefaultProjectHint(searchFrom);
    // A retired default comes back only as itself (defaultSearchStart); until
    // it has an index again there is nothing to open and nothing new to say.
    const start = this.defaultSearchStart(searchFrom);
    if (start === null) return;

    // Up-walk first; when nothing is indexed at or above searchFrom, a bounded
    // down-scan may adopt a SINGLE indexed sub-project as the default (#1606 —
    // the workspace-container shape where only children are indexed). Zero or
    // several candidates → no default project, but SAY so (#1607): the silent
    // variant of this state read as "CodeGraph is broken" and was diagnosable
    // only by knowing to look for a missing ~/.codegraph/daemons/ entry.
    const res = resolveServerRoot(start);
    const resolvedRoot = res.root && this.mayAdoptDefault(res.root) ? res.root : null;
    this.noteRootRefusal(res.refusal);
    if (!resolvedRoot) {
      // Sessions may still discover a project later via roots/list, and the
      // per-call retry re-resolves — this state is recoverable, hence stderr
      // (not a failure) + candidates surfaced through the tool-call error.
      this.projectPath = searchFrom;
      this.toolHandler.setKnownSubprojects(res.candidates, searchFrom);
      if (!res.refusal) {
        process.stderr.write(
          `[CodeGraph MCP] No .codegraph/ at or above ${searchFrom}: no default project, live sync disabled until an indexed project is accessed via projectPath.\n`
        );
      }
      if (res.candidates.length > 0) {
        const rels = res.candidates.map((c) => path.relative(searchFrom, c) || '.');
        process.stderr.write(
          `[CodeGraph MCP] Indexed sub-projects found: ${rels.join(', ')}. Pass \`projectPath\` per call, or launch with --path.\n`
        );
      }
      this.maybeStartPool(null);
      return;
    }
    if (res.viaSubScan) this.logSubprojectAdoption(searchFrom, resolvedRoot);

    this.projectPath = resolvedRoot;
    try {
      assertNoRebuild(resolvedRoot);
      const opened = await loadCodeGraph().open(resolvedRoot, { readOnly: this.opts.readOnly });
      if (this.closed) { opened.close(); return; }
      this.cg = opened;
      this.noteDefaultOpened(resolvedRoot);
      this.toolHandler.setDefaultCodeGraph(this.cg);
      this.startWatching();
      this.catchUpSync();
      this.maybeStartPool(resolvedRoot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[CodeGraph MCP] Failed to open project at ${resolvedRoot}: ${msg}\n`);
      // The agent otherwise hears only "no project loaded" (#995).
      this.toolHandler.setDefaultOpenFailure(reportableOpenFailure(err));
    }
  }

  /**
   * Record why the default project is refused (a sensitive folder, #2929's
   * guard), or clear that. Tool calls without a projectPath say why there is
   * no default project, and stderr says it once per reason, since every such
   * call re-resolves.
   */
  private noteRootRefusal(refusal: string | null): void {
    this.toolHandler.setDefaultRootRefusal(refusal);
    if (!refusal || refusal === this.loggedRootRefusal) return;
    this.loggedRootRefusal = refusal;
    process.stderr.write(
      `[CodeGraph MCP] ${refusal} — no default project, live sync disabled. Tool calls can still pass projectPath for a project elsewhere.\n`
    );
  }

  /** One stderr line when the default project came from the down-scan (#1606). */
  private logSubprojectAdoption(searchFrom: string, root: string): void {
    const rel = path.relative(searchFrom, root) || root;
    process.stderr.write(
      `[CodeGraph MCP] No .codegraph/ at ${searchFrom}; adopted the single indexed sub-project ${rel} as the default project.\n`
    );
  }

  /**
   * Start file watching on the active CodeGraph instance. Idempotent — the
   * watcher is per-engine, not per-session, which is why the daemon path
   * collapses N inotify sets to one. The wording of the disabled-reason log
   * exactly matches the prior in-tree implementation so log-driven dashboards
   * keep working.
   */
  private startWatching(): void {
    if (this.opts.readOnly || !this.cg || this.watcherStarted || !this.opts.watch) return;

    const opened = this.cg;
    this.defaultLease = acquireProject(opened.getProjectRoot(), () => opened, this.watchOptions());
    this.cg = this.defaultLease.cg;
    if (this.cg !== opened) opened.close();
    this.toolHandler.setDefaultCodeGraph(this.cg);
    this.watcherStarted = true;
  }

  /**
   * Reconcile the index with the current filesystem once, right after open —
   * catches edits, adds, deletes, and `git pull`/`checkout` changes made while
   * no watcher was running. Runs in the background, but the returned promise
   * is pushed into the ToolHandler as a one-shot gate so the *first* tool
   * call awaits completion before serving (without this, a tool call that
   * races past sync returns rows for files that no longer exist on disk —
   * and the per-file staleness banner can't help because `getPendingFiles()`
   * is populated by the watcher, not by catch-up).
   */
  private catchUpSync(afterReopen = false): void {
    const cg = this.cg;
    if (!cg || this.opts.readOnly) return;
    // The lease's gate is the startup reconcile and stays settled once caught
    // up; a database reopened after a rebuild (#1902) needs a sync of its own.
    if (this.defaultLease && !afterReopen) {
      this.toolHandler.setCatchUpGate(this.defaultLease.ready());
      return;
    }
    const p = cg
      .sync()
      .then((result) => {
        const changed = result.filesAdded + result.filesModified + result.filesRemoved;
        if (changed > 0) {
          process.stderr.write(`[CodeGraph MCP] Caught up ${changed} file(s) changed since last run\n`);
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[CodeGraph MCP] Catch-up sync failed: ${msg}\n`);
      });
    this.toolHandler.setCatchUpGate(p);
  }
}

/**
 * Parse and clamp the CODEGRAPH_WATCH_DEBOUNCE_MS env override.
 *
 * Issue #403: workspaces with bursty writes (formatter-on-save, multi-file
 * refactors) sometimes want a longer quiet window before sync. Returns
 * `undefined` for unset / empty / non-numeric / out-of-range values so the
 * FileWatcher default (2000ms) takes over — never throws.
 *
 * Clamp range: 100ms (faster would mean a sync per keystroke) to 60s (longer
 * and the watcher feels broken). Out-of-range values are treated as "ignore
 * this misconfiguration" rather than capped, since silently capping a 0 or
 * a typoed value would mask a real config bug.
 */
export function parseDebounceEnv(raw: string | undefined): number | undefined {
  if (!raw || !raw.trim()) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (n < 100 || n > 60000) return undefined;
  return n;
}
