/**
 * The builder's answer to `seed.ts`'s {@link SeedHost}: cold builds and seed copies run as jobs on the
 * builder's queue (./queue.ts), and this class remembers which roots have one queued or running so a call for
 * such a root answers "building" instead of queuing a second.
 *
 * Two kinds of job, two classes: a seed is a `seed` job (SYNC class: a copy, short), a cold build a
 * `cold-build` job (COLD class: it indexes a whole repository, so every queued SYNC job goes before it).
 */
import { canonicalProjectRoot } from '../../../directory';
import { ownIndexRootFor } from '../server/index-root';
import { COLD_BUILD_EXIT_BUSY, COLD_BUILD_EXIT_FAILED, runColdBuild } from '../worktree-lifecycle/cold-build';
import { admitColdBuild, isAtOrBelow, type ColdBuildApproval, type SeedHost } from '../worktree-lifecycle/seed';
import { isRebuildInProgress } from '../../../mcp/writer-lock';
import type { RebuildFences } from './fences';
import type { JobQueue } from './queue';

/** How long a call waits for its seed copy before it answers "building" and leaves the job queued. */
const DEFAULT_SEED_WAIT_MS = 10_000;

/**
 * `CODEGRAPH_BUILDER_ENSURE_WAIT_MS`: how long an `ensure` waits for a seed copy that is queued behind a
 * running job (a cold build runs for minutes and is never preempted) before it answers "building". A
 * non-negative integer; unset, blank or anything else: {@link DEFAULT_SEED_WAIT_MS}.
 */
export function resolveSeedWaitMs(raw: string | undefined = process.env.CODEGRAPH_BUILDER_ENSURE_WAIT_MS): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SEED_WAIT_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_SEED_WAIT_MS;
}

export class BuilderSeedHost implements SeedHost {
  /** Cold builds queued or running, by canonical root, with the root as it was queued. */
  private readonly cold = new Map<string, string>();
  /** Seed copies queued or running, likewise. */
  private readonly seeds = new Map<string, string>();
  /** Roots whose cold build failed in this builder: never retried until this builder restarts. */
  private readonly failed = new Set<string>();

  /**
   * `fences`: the builder's rebuild fences (./fences.ts). Without them (a host a test builds on its own) no
   * root is ever fenced, and only another live process's `rebuild.pid` holds a root.
   */
  constructor(
    private readonly queue: JobQueue,
    private readonly opts: { seedWaitMs?: number; log?: (line: string) => void; fences?: RebuildFences } = {},
  ) {}

  rebuildHeld(root: string): boolean {
    return this.opts.fences ? this.opts.fences.rebuildHeld(root) : isRebuildInProgress(root);
  }

  buildingRootFor(projectPath: string): string | null {
    if (this.cold.size === 0 && this.seeds.size === 0) return null;
    const p = canonicalProjectRoot(projectPath);
    for (const map of [this.cold, this.seeds]) {
      for (const [key, root] of map) {
        // A queued root above a git repository nested around `projectPath` is another repository's build: it
        // does not name the nested repository's path (a stat walk first, git only when a `.git` is below the root).
        if (isAtOrBelow(p, key) && ownIndexRootFor(projectPath, root) !== null) return root;
      }
    }
    return null;
  }

  hasFailedBuild(root: string): boolean {
    return this.failed.has(canonicalProjectRoot(root));
  }

  queueColdBuild(root: string, approval: ColdBuildApproval): void {
    const key = canonicalProjectRoot(root);
    if (this.cold.has(key)) return;
    this.cold.set(key, root);
    this.queue
      .enqueue('cold-build', root, async () => {
        // The same admission as at queue time (seed.ts), on what the root names now: a worktree removed while its
        // build waited must not be re-created by the lock's mkdir, and a root swapped for a link to another
        // directory (or into a git repository, for a plain build) must not be built. A refusal fails the job
        // (the job log carries the reason) and is not a failed build: nothing was tried, so a later call asks again.
        const admission = admitColdBuild(root, approval.plain, approval);
        if (!admission.ok) throw new Error(`the cold build was not started: ${admission.reason}`);
        // A `codegraph index` fenced the root while this job waited. runColdBuild would take the fence's own
        // `rebuild.pid` (same pid: re-acquired), and its release at the end would end the lease under it.
        if (this.opts.fences?.isFenced(root)) throw new Error('the cold build was not started: an index rebuild holds the root');
        const code = await runColdBuild(root);
        if (code === COLD_BUILD_EXIT_FAILED) {
          this.failed.add(key);
          throw new Error('the cold build failed');
        }
        // Someone else holds rebuild.pid: their build or `codegraph index` is at it. Not a failure of ours.
        if (code === COLD_BUILD_EXIT_BUSY) throw new Error('another process holds rebuild.pid');
      })
      .catch(() => { /* the job log has it */ })
      .finally(() => this.cold.delete(key));
  }

  async runSeed<T>(root: string, source: string, copy: () => Promise<T>): Promise<{ done: true; value: T } | { done: false }> {
    const key = canonicalProjectRoot(root);
    this.seeds.set(key, root);
    // The job is queued under the worktree but reads `source`'s database, so it is also a job of `source`: the
    // drain of a root being removed (queue.ts whenRootIdle) waits for it. `source` was chosen when the seed was
    // asked for, and the job may wait for minutes: when it starts it asks again, and a source or a target that
    // is being removed (a `release` fence of `codegraph uninit`) fails the seed before anything is opened.
    const checked = async (): Promise<T> => {
      this.opts.fences?.refuseIfRemoving(source);
      this.opts.fences?.refuseIfRemoving(root);
      return copy();
    };
    const settled = this.queue.enqueue('seed', root, checked, { alsoRoots: [source] }).finally(() => this.seeds.delete(key));
    let timer: NodeJS.Timeout | undefined;
    const waitMs = this.opts.seedWaitMs ?? resolveSeedWaitMs();
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), waitMs); });
    try {
      const outcome = await Promise.race([settled.then((value) => ({ done: true as const, value })), timeout]);
      if (outcome === 'timeout') {
        // A copy that outlasted the wait and then fails has no caller left to tell.
        settled.catch((err: unknown) => {
          this.opts.log?.(`Could not seed ${root}: ${err instanceof Error ? err.message : String(err)}`);
        });
        return { done: false };
      }
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }
}
