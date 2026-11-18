/**
 * Ends a job that went past a limit (./job-watchdog.ts finds it). The job runs in its own child process
 * (./job-supervisor.ts): the child is killed, and once it has closed the `job limit` line and the job's mark
 * (./ended-jobs-file.ts) are written, so no builder runs that job again until an explicit `codegraph index` or
 * `init`, and the job is cleaned up by the child's pid (./clean-up-ended-job.ts): a seed's staging copy removed,
 * a cold build's partial database removed only when its identity is the one the child reported creating, and the
 * locks naming the child released (a cold build whose child reported none keeps its `rebuild.pid` and database
 * for the next cold build to discard). A lock naming the builder (a held root's writer.pid) stays. The builder and
 * the jobs beside it go on.
 */
import { attempt } from './attempt';
import { cleanUpEndedJob } from './clean-up-ended-job';
import type { EndedJobsFile } from './ended-jobs-file';
import { isCreatedDatabase } from './is-created-database';
import { formatLimitLine } from './job-limit-line';
import type { LimitBreach } from './limit-breach';
import type { JobKind } from './queue';

/** End the over-limit `job` by killing its child; see the header. */
export async function endOverLimit(
  job: { kind: JobKind; root: string },
  breach: LimitBreach,
  deps: {
    jobLog: (line: string) => void;
    endedFile: Pick<EndedJobsFile, 'append'>;
    now?: () => Date;
    /** The over-limit job's child: its pid, the database identity it reported creating, and its kill. */
    child: { pid: number; createdDatabase: string | null; kill: () => Promise<void> };
  },
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const { root, kind } = job;
  const { child } = deps;
  await child.kill();
  attempt(() => deps.jobLog(formatLimitLine(job, breach, now())));
  attempt(() => deps.endedFile.append({ root, kind, limit: breach.limit, at: now().toISOString() }));
  cleanUpEndedJob(kind, root, child.pid, isCreatedDatabase(child.createdDatabase));
}
