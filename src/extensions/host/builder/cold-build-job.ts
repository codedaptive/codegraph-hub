/**
 * The builder's side of the `cold-build` job `jobId` of `root` (./seed-host.ts queues it). A cold build the
 * builder ended over a job limit (./ended-jobs.ts) is refused first, with no child started, and recorded as
 * failed (`onFailed`), so this builder queues it no more: it is not retried on its own, a builder restart does
 * not clear the mark, and only an explicit `codegraph index` or `codegraph init` does.
 * Then up to `attempts` attempts, each in its own child process through `runJob` (./cold-build-body.ts), with
 * `delayMs` between them. Admission (../worktree-lifecycle/seed.ts admitColdBuild) is repeated before each
 * attempt, since the root can change while queued or during a retry delay: a removed worktree must not be
 * re-created by the lock's mkdir, nor a root swapped for a link, or no longer a git worktree root, built. A refusal
 * is not a failed build, so a later call asks again. So is a root a `codegraph index` fenced meanwhile: the build
 * would take the fence's own `rebuild.pid` (same pid: re-acquired), and its release would end the lease under it.
 *
 * Resolves once built; rejects otherwise: ended or FAILED (after `onFailed`), BUSY (another process holds `rebuild.pid`:
 * their build or `codegraph index` is at it), or still LOCKED after the last attempt.
 */
import { COLD_BUILD_EXIT_BUSY, COLD_BUILD_EXIT_FAILED, COLD_BUILD_EXIT_LOCKED } from '../worktree-lifecycle/cold-build';
import { admitColdBuild, type ColdBuildApproval } from '../worktree-lifecycle/seed';
import { endedJobs } from './ended-jobs';
import type { RebuildFences } from './fences';
import { jobBodySpec } from './job-body-spec';
import { JobEndedError } from './job-ended-error';
import type { JobRunner } from './job-runner-type';

interface ColdBuildJobDeps {
  runJob: JobRunner;
  fences?: RebuildFences;
  attempts: number;
  delayMs: number;
  onFailed(): void;
}

export async function coldBuildJob(jobId: number, root: string, approval: ColdBuildApproval, deps: ColdBuildJobDeps): Promise<void> {
  const ended = endedJobs.find(root, 'cold-build');
  if (ended) {
    deps.onFailed();
    throw new JobEndedError(root, 'cold-build', ended.limit);
  }
  for (let attempt = 1; attempt <= deps.attempts; attempt++) {
    if (await builtByAttempt(jobId, root, approval, deps)) return;
    if (attempt < deps.attempts) await new Promise<void>((resolve) => setTimeout(resolve, deps.delayMs));
  }
  throw new Error(`the database stayed locked after ${deps.attempts} attempts; a later call asks again`);
}

/** One attempt: true when it built (or found the root indexed), false when the database was locked. */
async function builtByAttempt(jobId: number, root: string, approval: ColdBuildApproval, deps: ColdBuildJobDeps): Promise<boolean> {
  const admission = admitColdBuild(root, approval);
  if (!admission.ok) throw new Error(`the cold build was not started: ${admission.reason}`);
  if (deps.fences?.isFenced(root)) throw new Error('the cold build was not started: an index rebuild holds the root');
  const code = await deps.runJob<number>(jobId,jobBodySpec('cold-build', root, 'cold-build-body', 'coldBuildBody', { root }));
  if (code === COLD_BUILD_EXIT_FAILED) {
    deps.onFailed();
    throw new Error('the cold build failed');
  }
  if (code === COLD_BUILD_EXIT_BUSY) throw new Error('another process holds rebuild.pid');
  return code !== COLD_BUILD_EXIT_LOCKED;
}
