/**
 * The body of one attempt of a `cold-build` job (./cold-build-job.ts), run in the job's child process: the cold
 * build of `root` (../worktree-lifecycle/cold-build.ts runColdBuild), answered with its exit code. The database
 * the build registers as its own (../worktree-lifecycle/cold-build-database.ts) is reported to the builder
 * (`ctx.reportDatabase`) as it is registered, so a child killed at a limit or after the stop's grace has that
 * database, and only that one, rolled back (./clean-up-ended-job.ts).
 */
import { runColdBuild } from '../worktree-lifecycle/cold-build';
import { coldBuildDatabases } from '../worktree-lifecycle/cold-build-database';
import type { JobContext } from './job-context-type';

export function coldBuildBody(args: { root: string }, ctx: JobContext): Promise<number> {
  coldBuildDatabases.onSet((root, created) => ctx.reportDatabase(root, created));
  return runColdBuild(args.root);
}
