/**
 * The builder's answer to `seed.ts`'s {@link SeedHost}: cold builds and seed copies run as jobs on the
 * builder's queue (./queue.ts), and this class remembers which roots have one queued or running so a call for
 * such a root answers "building" instead of queuing a second.
 *
 * Two kinds of job, two classes: a seed is a `seed` job (SYNC class: a copy, short), a cold build a
 * `cold-build` job (COLD class: it indexes a whole repository, so every queued SYNC job goes before it).
 */
import * as fs from 'fs';
import { canonicalProjectRoot } from '../../../directory';
import { COLD_BUILD_EXIT_BUSY, COLD_BUILD_EXIT_FAILED, runColdBuild } from '../worktree-lifecycle/cold-build';
import { isAtOrBelow, type SeedHost } from '../worktree-lifecycle/seed';
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
  /** Roots whose cold build failed in this builder: not retried on every call. */
  private readonly failed = new Set<string>();

  constructor(
    private readonly queue: JobQueue,
    private readonly opts: { seedWaitMs?: number; log?: (line: string) => void } = {},
  ) {}

  buildingRootFor(projectPath: string): string | null {
    if (this.cold.size === 0 && this.seeds.size === 0) return null;
    const p = canonicalProjectRoot(projectPath);
    for (const map of [this.cold, this.seeds]) {
      for (const [key, root] of map) if (isAtOrBelow(p, key)) return root;
    }
    return null;
  }

  hasFailedBuild(root: string): boolean {
    return this.failed.has(canonicalProjectRoot(root));
  }

  queueColdBuild(root: string): void {
    const key = canonicalProjectRoot(root);
    if (this.cold.has(key)) return;
    this.cold.set(key, root);
    this.queue
      .enqueue('cold-build', root, async () => {
        // A worktree removed while its build waited must not be re-created by the lock's mkdir.
        if (!fs.existsSync(root)) throw new Error(`${root} no longer exists`);
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

  async runSeed<T>(root: string, copy: () => Promise<T>): Promise<{ done: true; value: T } | { done: false }> {
    const key = canonicalProjectRoot(root);
    this.seeds.set(key, root);
    const settled = this.queue.enqueue('seed', root, copy).finally(() => this.seeds.delete(key));
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
