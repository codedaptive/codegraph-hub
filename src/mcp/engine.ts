/**
 * MCP shared engine — the heavyweight, *shared* state of an MCP server: the
 * {@link ToolHandler} with its cache of open projects, the file watchers and
 * writer slots those projects hold, the worker-thread query pool, and the
 * housekeeping pass that tears down registered projects whose worktree is gone
 * and lets go of held projects whose directory or index another process removed.
 *
 * The engine has no default project. It opens nothing at startup and a session
 * never initializes it: every tool call names its `projectPath`, and the
 * ToolHandler opens that project on its first call (see
 * `ToolHandler.getCodeGraph`), keeps it while it is in use, and closes it once
 * idle (pinned projects stay open). There is no cap on how many are open.
 *
 * One engine, many sessions:
 * - the machine server (daemon.ts) instantiates one engine and a new session
 *   per socket connection; every session reads from the same SQLite WAL and
 *   the same inotify watch set — that's the entire point of issue #411;
 * - direct mode (`CODEGRAPH_NO_DAEMON`, a single stdio session) instantiates
 *   one engine + one session;
 * - the proxy's in-process fallback instantiates a read-only engine.
 */

import * as os from 'os';
import type CodeGraph from '../index';
import { canonicalProjectRoot } from '../directory';
import { ToolHandler } from './tools';
import { assertNoRebuild } from './writer-lock';
import { QueryPool, resolvePoolSize } from './query-pool';
import { endFreshnessMeasurements } from './index-freshness';
import { acquireProject, ProjectLease } from './project-lifecycle';
import { EngineHousekeeping } from '../extensions/host/worktree-lifecycle/housekeeping';

export interface MCPEngineOptions {
  /** Serve existing index contents without syncing, watching, or claiming a writer slot. */
  readOnly?: boolean;
  /**
   * Whether to start file watchers on the projects it opens. The machine server
   * and direct mode both want this true; tests may set it false to keep the
   * engine cheap. Honors the watcher's own disabled-reason (resource limits)
   * regardless.
   */
  watch?: boolean;
  /**
   * Whether to off-load read-tool dispatch to a worker-thread pool, started
   * when the engine is constructed (never for a read-only engine). The machine
   * server and direct sessions can issue concurrent calls on one event loop.
   * `CODEGRAPH_QUERY_POOL_SIZE=0` disables it in either mode.
   */
  queryPool?: boolean;
  /**
   * Worker cap when `CODEGRAPH_QUERY_POOL_SIZE` is unset. A direct (single-client)
   * session sets a small cap so every session doesn't hold one worker per core;
   * the machine server leaves it unset and scales with the machine.
   */
  queryPoolDefaultMax?: number;
}

/**
 * Shared MCP engine. Thread-safe in the sense that multiple sessions can
 * call its methods concurrently; the ToolHandler serializes opening a project
 * so sessions racing each other on first call never double-open one SQLite file.
 */
export class MCPEngine {
  private toolHandler: ToolHandler;
  // Retained synchronization ownership for each cached project: one lease per
  // lifecycle open. acquireProject hands every open of a root the same
  // CodeGraph while it is held, so one graph can carry two leases: a call that
  // reopens a root while the handler's releaseProjectRoot waits for in-flight
  // calls takes a second one before the first is released. Each release
  // returns exactly one, so neither is dropped or leaked.
  private explicitProjects = new Map<CodeGraph, ProjectLease[]>();
  private opts: Required<Omit<MCPEngineOptions, 'queryPoolDefaultMax'>> & Pick<MCPEngineOptions, 'queryPoolDefaultMax'>;
  private closed = false;
  private stopPromise: Promise<void> | null = null;
  // Off-loop read-tool pool. Workers each hold their own WAL read connections,
  // opened lazily per project on a call's `projectPath`.
  private queryPool: QueryPool | null = null;
  // Housekeeping: the timer and the pass that release projects whose directory or index is gone.
  private housekeeping: EngineHousekeeping;

  constructor(opts: MCPEngineOptions = {}) {
    this.opts = { readOnly: opts.readOnly ?? false, watch: opts.watch ?? true, queryPool: opts.queryPool ?? false, queryPoolDefaultMax: opts.queryPoolDefaultMax };
    this.housekeeping = new EngineHousekeeping({
      releaseProjectRoot: (root) => this.releaseProjectRoot(root),
      cachedProjectRoots: () => this.toolHandler.cachedProjectRoots(),
      readOnly: this.opts.readOnly,
    });
    this.toolHandler = new ToolHandler(null);
    this.toolHandler.setReadOnly(this.opts.readOnly);
    this.toolHandler.setProjectLifecycle({
      open: (root, open) => {
        // Every project holds SQLite handles (a read-only engine's too). Fence
        // the open against a running `codegraph index` rebuild.
        assertNoRebuild(root);
        if (this.opts.queryPool) this.housekeeping.notePoolOpenedRoot(root);
        // `open` is the handler's one open path; it opens read-only when this
        // engine is (setReadOnly above). A read-only or non-watching engine takes
        // no lease: no watcher, no writer slot.
        if (this.opts.readOnly || !this.opts.watch) return open();
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
    // A tool call found a project's database replaced on disk (a `codegraph
    // index` rebuild) and reopened it (#1902). Reconcile the new file with the
    // usual catch-up — `sync()` serializes on the index mutex, so it never
    // overlaps an in-flight watcher sync. Only for a project this engine is
    // watching, i.e. its writer: a read-only engine, or a project whose writer
    // slot another process holds, must not start writing.
    this.toolHandler.setOnDatabaseReopened((cg) => {
      if (cg.isWatching()) this.catchUpAfterReopen(cg);
    });
    // The pool opens no project (each worker opens one on a call's first
    // `projectPath`), so it starts here, not on a first call.
    this.maybeStartPool();
    // Housekeeping (src/extensions/host/worktree-lifecycle/housekeeping.ts):
    // a timer, stopped in stop().
    this.housekeeping.start();
  }

  /**
   * One housekeeping pass, now, whatever CODEGRAPH_HOUSEKEEPING_INTERVAL_MS
   * says (the timer runs the same pass): the registry sweep (skipped on a
   * read-only engine), then the release, through {@link releaseProjectRoot},
   * of every project this engine holds whose directory or
   * `.codegraph/codegraph.db` is gone. Never rejects. A no-op once the engine
   * is stopped.
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
      this.queryPool = new QueryPool({ size });
      this.toolHandler.setQueryPool(this.queryPool);
      process.stderr.write(`[CodeGraph MCP] Query pool: up to ${size} worker thread(s) for concurrent reads.\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[CodeGraph MCP] Query pool unavailable (${msg}); serving reads in-process.\n`);
      this.queryPool = null;
    }
  }

  /** Whether this engine only reads: no watcher, no sync, no writer slot. */
  isReadOnly(): boolean {
    return this.opts.readOnly;
  }

  /** Shared ToolHandler — sessions delegate tool dispatch through this. */
  getToolHandler(): ToolHandler {
    return this.toolHandler;
  }

  /**
   * Close every handle this engine holds on project `root`: the tool
   * handler's cached connection (through the project lifecycle, so its watcher
   * stops and its writer slot is released), then each query-pool worker's own
   * connection (broadcast to every worker, so a worker still holding a root
   * the handler's cache already dropped closes it too). A later call that
   * names the root opens it again. The housekeeping sweep calls this before it
   * deletes a removed worktree's index, each housekeeping pass calls it for a
   * held project whose directory or database is gone, and a session's
   * `codegraph/releaseProject` request calls it so a CLI can take the
   * project's writer slot.
   */
  async releaseProjectRoot(root: string): Promise<void> {
    const canonical = canonicalProjectRoot(root);
    await this.toolHandler.releaseProjectRoot(canonical);
    await this.queryPool?.releaseProject(canonical);
  }

  /**
   * Close everything. Used on graceful server shutdown (SIGTERM) and on
   * direct-mode stop. Idempotent. Stops the housekeeping sweep first, so no
   * teardown starts while the engine closes.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.closed = true;
    this.housekeeping.stop();

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

  /**
   * Catch-up sync of a project whose replaced database was just reopened
   * (#1902). The returned promise is pushed into the ToolHandler as a one-shot
   * gate, so the next tool call awaits the reconcile (time-boxed) before
   * serving, instead of answering from rows the replaced file never saw.
   */
  private catchUpAfterReopen(cg: CodeGraph): void {
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

  /** Watch options for every project the engine watches. */
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
