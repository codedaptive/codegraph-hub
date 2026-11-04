/**
 * An MCP engine's housekeeping (src/mcp/engine.ts): the timer and the on-demand
 * pass of ./teardown.ts, wired to one engine through a small adapter.
 *
 * Every CODEGRAPH_HOUSEKEEPING_INTERVAL_MS (default 60 s, 0 off) one pass runs
 * (`runHousekeepingPass`, the same pass {@link EngineHousekeeping.runPass} runs
 * on demand): tear down registered projects whose worktree is gone, releasing
 * them in the engine first, then release every project the engine holds whose
 * directory or database is gone (the first process to sweep a root
 * unregisters it, so no other process's sweep sees it). A read-only engine
 * deletes nothing, so it skips the sweep and only releases: the machine
 * server's engine is always read-only, and the index builder
 * (src/extensions/host/builder/service.ts) is the one that sweeps, with its
 * own hold set, through an engine adapter that is not read-only. The timer is
 * unref'd. An engine may give an `afterPass` hook, run at the end of every pass
 * (timer or on demand): the machine server's engine uses it to re-run the idle
 * release and to run a pass of the pinned-project opener (./pinned-open.ts, wired
 * in src/mcp/engine.ts); the
 * builder's adapter gives none, so its pass is unchanged.
 *
 * The roots a server's engine holds are the tool handler's cache, the roots
 * its query-pool workers may still hold (recorded here as the engine opens
 * them, {@link EngineHousekeeping.notePoolOpenedRoot}). The builder's are the
 * roots it holds writable.
 */
import { canonicalProjectRoot } from '../../../directory';
import { runHousekeepingPass, startHousekeeping, type TeardownDeps } from './teardown';

/**
 * Bound on the record of explicit roots an engine's query-pool workers may
 * hold. Past it the oldest is forgotten: that root's workers then let go of it
 * through their own idle release instead of the housekeeping pass. The bound
 * keeps a long-lived engine that is handed many distinct roots from growing
 * this set without limit; 256 is ample because a session works in a handful
 * of projects, and a root that falls off is still released, only later.
 */
const MAX_POOL_OPENED_ROOTS = 256;

/** What the housekeeping needs from its engine. */
export interface HousekeepingEngine {
  /**
   * Close every handle the engine holds on `root`. The pass calls it before
   * the sweep deletes a removed worktree's index, and for each held root whose
   * directory or database is gone.
   */
  releaseProjectRoot(root: string): Promise<void>;
  /** The roots of the projects the tool handler holds open now. */
  cachedProjectRoots(): string[];
  /** A read-only engine only releases; it never sweeps the registry. */
  readOnly: boolean;
  /** Optional: runs at the end of every pass, see {@link TeardownDeps.afterPass}. */
  afterPass?(): void;
}

export class EngineHousekeeping {
  // Canonical roots the main handler opened while a query pool may run. A
  // worker opens a root only after the main handler did (calls are gated on
  // the main thread first), so this covers every root a worker may still hold
  // after the main cache dropped it (idle release).
  private poolOpenedRoots = new Set<string>();
  private readonly deps: TeardownDeps;
  private stopTimer: (() => void) | null = null;

  constructor(private readonly engine: HousekeepingEngine) {
    this.deps = {
      release: async (root) => {
        await this.engine.releaseProjectRoot(root);
        this.poolOpenedRoots.delete(canonicalProjectRoot(root));
      },
      heldRoots: () => this.heldRoots(),
      releaseOnly: engine.readOnly,
      afterPass: engine.afterPass ? () => engine.afterPass?.() : undefined,
    };
  }

  /** Start the interval timer (a no-op when the interval is 0, or when already started). */
  start(): void {
    if (!this.stopTimer) this.stopTimer = startHousekeeping(this.deps);
  }

  /** Stop the interval timer; a pass already running finishes. */
  stop(): void {
    this.stopTimer?.();
    this.stopTimer = null;
  }

  /** One pass now, whatever the interval says. Never rejects. */
  runPass(): Promise<void> {
    return runHousekeepingPass(this.deps);
  }

  /** Record that the engine opened explicit `root` while a query pool may hold it too. */
  notePoolOpenedRoot(root: string): void {
    const canonical = canonicalProjectRoot(root);
    this.poolOpenedRoots.delete(canonical); // re-insert: newest last
    this.poolOpenedRoots.add(canonical);
    if (this.poolOpenedRoots.size > MAX_POOL_OPENED_ROOTS) {
      const oldest = this.poolOpenedRoots.values().next().value;
      if (oldest !== undefined) this.poolOpenedRoots.delete(oldest);
    }
  }

  /**
   * Roots the engine may hold, canonical: the handler's cache, the roots
   * query-pool workers may still hold.
   */
  private heldRoots(): string[] {
    const roots = new Set<string>(this.engine.cachedProjectRoots().map((r) => canonicalProjectRoot(r)));
    for (const r of this.poolOpenedRoots) roots.add(r);
    return [...roots];
  }
}
