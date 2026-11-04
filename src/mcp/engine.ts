/**
 * MCP shared engine — the heavyweight, *shared* state of an MCP server: the
 * {@link ToolHandler} with its cache of open projects, the worker-thread query
 * pool, and the housekeeping pass that lets go of held projects whose worktree,
 * directory or index is gone.
 *
 * The engine only reads. Every project it opens is opened read-only, and it
 * never syncs, watches, seeds, builds, recovers an index or takes a writer slot:
 * every index write belongs to the index builder (src/extensions/host/builder/),
 * a separate process the engine's owner starts and passes in as `builder`. The
 * engine asks it to hold each project a call names (the builder watches and
 * syncs it), waits on its catch-up, reads its freshness, and tells it to let go
 * of a project the engine closes. An engine without a builder (the proxy's
 * in-process fallback) serves whatever the indexes hold and nothing more.
 *
 * The engine has no default project, and a session never initializes it: every
 * tool call names its `projectPath`, and the ToolHandler opens that project on
 * its first call (see `ToolHandler.getCodeGraph`), keeps it while it is in use,
 * and closes it once idle (pinned projects stay open). There is no cap on how
 * many are open. The one thing an engine may open with no call is a pinned
 * project, and only when its owner sets `openPinned` and gives a builder (the
 * machine server does): it opens each pinned project that has an index at
 * startup and after each housekeeping pass
 * (src/extensions/host/worktree-lifecycle/pinned-open.ts).
 *
 * One engine, many sessions:
 * - the machine server (daemon.ts) instantiates one engine and a new session
 *   per socket connection; every session reads from the same SQLite WAL and
 *   the same builder — that's the entire point of issue #411;
 * - direct mode (`CODEGRAPH_NO_DAEMON`, a single stdio session) instantiates
 *   one engine + one session, with a builder of its own;
 * - the proxy's in-process fallback instantiates an engine with no builder.
 */

import * as os from 'os';
import type CodeGraph from '../index';
import { canonicalProjectRoot } from '../directory';
import { ToolHandler } from './tools';
import { assertNoRebuild } from './writer-lock';
import { QueryPool, resolvePoolSize } from './query-pool';
import { endFreshnessMeasurements } from './index-freshness';
import type { BuilderClient } from '../extensions/host/builder/client';
import { EngineHousekeeping } from '../extensions/host/worktree-lifecycle/housekeeping';
import { PinnedProjectOpener } from '../extensions/host/worktree-lifecycle/pinned-open';

export interface MCPEngineOptions {
  /**
   * The index builder that does every index write for this engine's projects.
   * The machine server and direct mode pass theirs (and stop it after the
   * engine); the proxy's in-process fallback passes none and so never causes a
   * write: a worktree with no index of its own gets the not-indexed guidance,
   * and `fresh: true` only measures.
   */
  builder?: BuilderClient;
  /**
   * Whether to off-load read-tool dispatch to a worker-thread pool, started
   * when the engine is constructed. The machine server and direct sessions can
   * issue concurrent calls on one event loop. `CODEGRAPH_QUERY_POOL_SIZE=0`
   * disables it in either mode.
   */
  queryPool?: boolean;
  /**
   * Worker cap when `CODEGRAPH_QUERY_POOL_SIZE` is unset. A direct (single-client)
   * session sets a small cap so every session doesn't hold one worker per core;
   * the machine server leaves it unset and scales with the machine.
   */
  queryPoolDefaultMax?: number;
  /**
   * Open every project the registry marks pinned (`codegraph project pin`) that
   * has an index, with no tool call: once right after construction, and again
   * after each housekeeping pass, which also re-runs the idle release so a project
   * unpinned later is closed with no call to trigger it. Effective only with a
   * `builder` (the opens have the builder hold each project, and the engine writes
   * nothing itself). The machine server sets it; direct mode does not: a direct
   * stdio session is a per-session fallback, and opening every pinned root there
   * would contend with the machine server for the writer slots. With
   * CODEGRAPH_HOUSEKEEPING_INTERVAL_MS=0 no pass runs, so a pin made after the
   * start is picked up at the next server start only.
   */
  openPinned?: boolean;
}

/**
 * Shared MCP engine. Thread-safe in the sense that multiple sessions can
 * call its methods concurrently; the ToolHandler serializes opening a project
 * so sessions racing each other on first call never double-open one SQLite file.
 */
export class MCPEngine {
  private toolHandler: ToolHandler;
  // The builder that holds (watches, syncs) each project this engine has open;
  // null for the in-process fallback.
  private builder: BuilderClient | null;
  private opts: Required<Omit<MCPEngineOptions, 'queryPoolDefaultMax' | 'builder'>> & Pick<MCPEngineOptions, 'queryPoolDefaultMax'>;
  // Opens the registry's pinned projects with no call; null unless `openPinned` was set
  // together with a builder.
  private pinnedOpener: PinnedProjectOpener | null = null;
  private closed = false;
  private stopPromise: Promise<void> | null = null;
  // Off-loop read-tool pool. Workers each hold their own WAL read connections,
  // opened lazily per project on a call's `projectPath`.
  private queryPool: QueryPool | null = null;
  // Housekeeping: the timer and the pass that release projects whose directory or index is gone.
  private housekeeping: EngineHousekeeping;

  constructor(opts: MCPEngineOptions = {}) {
    this.opts = { queryPool: opts.queryPool ?? false, queryPoolDefaultMax: opts.queryPoolDefaultMax, openPinned: opts.openPinned ?? false };
    this.builder = opts.builder ?? null;
    const openPinned = this.opts.openPinned && this.builder !== null;
    this.housekeeping = new EngineHousekeeping({
      releaseProjectRoot: (root) => this.releaseProjectRoot(root),
      cachedProjectRoots: () => this.toolHandler.cachedProjectRoots(),
      // Release-only: the engine deletes no index; the builder runs the sweep.
      readOnly: true,
      // Only an engine that opens pinned projects re-runs the idle release and the
      // opener after a pass; every other engine's pass ends with the release.
      ...(openPinned ? { afterPass: () => this.afterHousekeepingPass() } : {}),
    });
    this.toolHandler = new ToolHandler(null);
    // Every project the handler opens is opened read-only (ToolHandler.openProjectRoot).
    this.toolHandler.setReadOnly(true);
    if (this.builder) this.toolHandler.setBuilder(this.builder);
    this.toolHandler.setProjectLifecycle({
      open: (root, open) => {
        // Every project holds SQLite handles. Fence the open against a running
        // `codegraph index` rebuild.
        assertNoRebuild(root);
        if (this.opts.queryPool) this.housekeeping.notePoolOpenedRoot(root);
        // `open` is the handler's one open path: read-only (setReadOnly above).
        // With a builder, `ensure` has answered before this point: it
        // resolves once the builder opened (and migrated) the index, or after
        // a bounded wait when that open is queued behind a running job, or when
        // the hold could not open it (another live writer, an open failure).
        // This open is read-only whatever is on disk then; without a builder
        // the index is opened as it is.
        return open();
      },
      // The builder's queued catch-up of the project's index; resolved at once
      // without a builder.
      activate: (cg) => this.builder?.caughtUp(cg.getProjectRoot()) ?? Promise.resolve(),
      release: (cg) => this.releaseHandle(cg),
    });
    // A tool call found a project's database replaced on disk (a `codegraph
    // index` rebuild) and reopened it (#1902). Reconcile the new file with a
    // sync job on the builder (it serializes on its queue and on the index
    // mutex), never one of ours: the engine only reads.
    this.toolHandler.setOnDatabaseReopened((cg) => {
      if (this.builder) this.catchUpAfterReopen(this.builder, cg);
    });
    // The pool opens no project (each worker opens one on a call's first
    // `projectPath`), so it starts here, not on a first call.
    this.maybeStartPool();
    // Housekeeping (src/extensions/host/worktree-lifecycle/housekeeping.ts):
    // a timer, stopped in stop().
    this.housekeeping.start();
    if (openPinned) this.startPinnedOpener();
  }

  /**
   * Create the pinned-project opener and run its first pass. The pass starts on
   * the next turn of the event loop and is not awaited, so the constructor, and
   * the machine server's socket bind after it, never wait on a registry read or
   * a builder hold. A pass never rejects.
   */
  private startPinnedOpener(): void {
    const opener = new PinnedProjectOpener({
      // Open AND held. The handler caches a root even when the builder's `ensure`
      // answered `none` and recorded no hold (the builder not up in time, an IPC
      // failure); such a root is open but never watched or synced, so it counts as
      // not open and the next pass asks the builder again (ToolHandler.needsBuilderEnsure
      // re-ensures a cached root the builder reports nothing for, and the cached
      // handle is reused, so nothing is opened twice). `freshness` is the builder's last
      // push: between a successful ensure and the first push it is null, which costs one
      // more idempotent ensure on the next pass.
      isOpen: (root) => this.toolHandler.isProjectRootOpen(root) && (this.builder?.freshness(root) ?? null) !== null,
      open: async (root) => {
        // The opener also stops itself in stop(); the flag covers a pass already
        // between its check and this call.
        if (this.closed) return;
        await this.toolHandler.openPinnedProject(root);
      },
      log: (line) => process.stderr.write(`${line}\n`),
    });
    this.pinnedOpener = opener;
    setImmediate(() => void opener.pass());
  }

  /**
   * The end of each housekeeping pass of an engine that opens pinned projects:
   * run the idle release (a project opened for a pin and unpinned since arms no
   * idle timer and gets no call to trim it), then open any pinned project not yet
   * open (a pin made since the last pass). A pin is picked up by the first pass
   * that starts after the pass in flight, if any, has finished: a pass has no time
   * bound (its ensures wait on the builder) and a call while one runs returns it
   * instead of starting another. The opener's pass runs on its own and is not
   * awaited: a slow hold must not make the timer skip ticks.
   */
  private afterHousekeepingPass(): void {
    if (this.closed) return;
    this.toolHandler.trimIdleProjects();
    void this.pinnedOpener?.pass();
  }

  /**
   * One housekeeping pass, now, whatever CODEGRAPH_HOUSEKEEPING_INTERVAL_MS
   * says (the timer runs the same pass): the release, through
   * {@link releaseProjectRoot}, of every project this engine holds whose
   * directory or `.codegraph/codegraph.db` is gone. The registry sweep, which
   * deletes the indexes of removed worktrees, is the builder's. On an engine
   * that opens pinned projects the pass ends with the idle release and a new
   * pass of the pinned-project opener (not awaited). Never rejects. A no-op
   * once the engine is stopped.
   */
  async runHousekeepingTick(): Promise<void> {
    if (this.closed) return;
    await this.housekeeping.runPass();
  }

  /**
   * Start the worker-thread query pool. Honors `CODEGRAPH_QUERY_POOL_SIZE`;
   * best-effort: if workers can't spawn on this platform the ToolHandler keeps
   * serving reads in-process, so the pool can only help, never break, tool calls.
   */
  private maybeStartPool(): void {
    if (!this.opts.queryPool || this.queryPool || this.closed) return;
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
      this.queryPool = new QueryPool({ size });
      this.toolHandler.setQueryPool(this.queryPool);
      process.stderr.write(`[CodeGraph MCP] Query pool: up to ${size} worker thread(s) for concurrent reads.\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[CodeGraph MCP] Query pool unavailable (${msg}); serving reads in-process.\n`);
      this.queryPool = null;
    }
  }

  /** Shared ToolHandler — sessions delegate tool dispatch through this. */
  getToolHandler(): ToolHandler {
    return this.toolHandler;
  }

  /**
   * The index builder this engine was given, or null (the proxy's in-process fallback). A session relays
   * the codegraph CLI's index writes (`codegraph/indexWrite`) to it; the engine itself writes nothing.
   */
  getBuilder(): BuilderClient | null {
    return this.builder;
  }

  /**
   * Let go of project `root`: close the tool handler's cached connection,
   * then each query-pool worker's own connection (broadcast to every worker,
   * so a worker still holding a root the handler's cache already dropped
   * closes it too), then have the builder drop its hold (watcher, writer
   * slot) and wait until it has. A later call that names the root opens it
   * again and the builder holds it again. The builder's hold is dropped even
   * for a root the handler no longer caches. Two requests call it so the CLI can
   * rebuild or delete the project's index: a session's
   * `codegraph/releaseProject` (the in-process `codegraph index`, which takes
   * the slot itself, and the in-process `codegraph uninit`), answered 'released' only after it resolves, and the
   * relay of `codegraph/indexWrite` (the routed `codegraph index`, whose
   * rebuild the builder runs, and the routed `codegraph uninit`, whose `release` op
   * stops after the fence and the release, and leaves the delete to the CLI), after the builder has fenced the root. Each
   * housekeeping pass calls it for a held project whose directory or
   * database is gone.
   */
  async releaseProjectRoot(root: string): Promise<void> {
    const canonical = canonicalProjectRoot(root);
    await this.toolHandler.releaseProjectRoot(canonical);
    await this.queryPool?.releaseProject(canonical);
    await this.builder?.release(canonical);
  }

  /**
   * Close everything. Used on graceful server shutdown (SIGTERM) and on
   * direct-mode stop. Idempotent. Stops the housekeeping sweep first, so no
   * teardown starts while the engine closes. The builder is not stopped here:
   * whoever passed it in stops it, after this resolves.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.closed = true;
    this.housekeeping.stop();
    // No pass starts another open from here. An open already awaiting the builder
    // may still complete; the handler's trailing trim releases it while closing.
    this.pinnedOpener?.stop();

    // Detach + terminate the worker pool first so no tool call routes to a
    // worker mid-teardown; outstanding pool calls resolve with graceful guidance.
    // Stopping waits for the workers to end — the pool's, and any
    // `codegraph_status` change count still measuring: the server exits right
    // after, and exiting while a worker is still starting up can crash the
    // process.
    this.toolHandler.setQueryPool(null);
    const poolDown = this.queryPool ? this.queryPool.destroy() : Promise.resolve();
    this.queryPool = null;
    const measurementsDown = endFreshnessMeasurements();
    const drained = this.toolHandler.closeAll();
    this.stopPromise = Promise.all([drained, poolDown, measurementsDown]).then(() => undefined);
    return this.stopPromise;
  }

  /**
   * The handler's idle release or shutdown close of `cg`: close the read-only
   * handle, then have the builder drop its hold on the project, so its watcher
   * stops and its writer slot frees. Never rejects (BuilderClient.release). A
   * call that reopens the root meanwhile finds the builder no longer reports
   * it and asks it to hold the root again (ToolHandler.seedWorktreeIndex).
   */
  private async releaseHandle(cg: CodeGraph): Promise<void> {
    const root = cg.getProjectRoot();
    cg.close();
    await this.builder?.release(root);
  }

  /**
   * Catch-up of a project whose replaced database was just reopened (#1902):
   * a sync job on the builder. The returned promise is pushed into the
   * ToolHandler as a one-shot gate, so the next tool call awaits the reconcile
   * (time-boxed) before serving, instead of answering from rows the replaced
   * file never saw.
   */
  private catchUpAfterReopen(builder: BuilderClient, cg: CodeGraph): void {
    const p = builder
      .sync(cg.getProjectRoot())
      .then((result) => {
        if (result.filesChanged > 0) {
          process.stderr.write(`[CodeGraph MCP] Caught up ${result.filesChanged} file(s) changed since last run\n`);
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[CodeGraph MCP] Catch-up sync failed: ${msg}\n`);
      });
    this.toolHandler.setCatchUpGate(p);
  }
}
