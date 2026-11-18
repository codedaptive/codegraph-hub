/**
 * Ends a job that went past a limit (./job-watchdog.ts finds it). Either way it writes the `job limit` line and
 * the job's mark (./ended-jobs-file.ts), so no builder runs that job again until an explicit `codegraph index` or
 * `init`, and cleans up after the job (./clean-up-ended-job.ts): a partial cold build rolled back, a seed's staging
 * copy removed, the root's locks released. How it ends the job depends on where the job runs.
 *
 * A job in its own child process (./job-supervisor.ts): the child is killed, and once it has exited the line and
 * mark are written and the cleanup matches the child's pid, so a lock naming the builder stays. A cold build's
 * database is removed only when its identity is the one the child reported creating. The builder and the jobs
 * beside it go on.
 *
 * A job in the builder's own process cannot be interrupted halfway, so the builder exits with code 75 and the
 * server's client restarts it. After the line and mark, every job child is killed and waited for; then the
 * over-limit job is cleaned up by the builder's pid, and so is each job `alongside` it in the builder's process,
 * which the exit ends too: each gets a failed `job end` line naming the over-limit job and the same cleanup, but no
 * mark, since it was not over a limit and runs again when something asks for it.
 */
import { statInode } from '../../../directory';
import { coldBuildDatabases } from '../worktree-lifecycle/cold-build-database';
import { attempt } from './attempt';
import { cleanUpEndedJob } from './clean-up-ended-job';
import type { EndedJobsFile } from './ended-jobs-file';
import { formatLimitLine } from './job-limit-line';
import type { LimitBreach } from './limit-breach';
import { formatJobLine, type JobKind } from './queue';

/** EX_TEMPFAIL (sysexits.h): the builder ended itself over a job, and a restart is the expected answer. */
const JOB_LIMIT_EXIT_CODE = 75;

/**
 * End the over-limit `job` in its child when `deps.child` is set, else end the builder; see the header. Without a
 * child and without `killAll`, the builder's exit is called before this returns.
 */
export function endOverLimit(
  job: { kind: JobKind; root: string },
  breach: LimitBreach,
  deps: {
    jobLog: (line: string) => void;
    endedFile: Pick<EndedJobsFile, 'append'>;
    beforeExit: () => void;
    exit: (code: number) => void;
    pid?: number;
    now?: () => Date;
    /** The jobs running in the builder's process beside the over-limit one, which the builder's exit ends too. */
    alongside?: readonly { kind: JobKind; root: string }[];
    /** The over-limit job's child: its pid, the database identity it reported creating, and its kill. */
    child?: { pid: number; createdDatabase: string | null; kill: () => Promise<void> };
    /** Kills every job child; resolves once all have exited. */
    killAll?: () => Promise<void>;
  },
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const { root, kind } = job;
  const logAndMark = (): void => {
    attempt(() => deps.jobLog(formatLimitLine(job, breach, now())));
    attempt(() => deps.endedFile.append({ root, kind, limit: breach.limit, at: now().toISOString() }));
  };
  const { child, killAll } = deps;
  if (child) {
    return child.kill().then(() => {
      logAndMark();
      const { createdDatabase } = child;
      cleanUpEndedJob(kind, root, child.pid, (_root, dbFile) => createdDatabase !== null && statInode(dbFile) === createdDatabase);
    });
  }
  const exitBuilder = (): void => {
    const pid = deps.pid ?? process.pid;
    cleanUpEndedJob(kind, root, pid, coldBuildDatabases.isOurs);
    const error = `the builder ended over the ${breach.limit} limit of ${kind} ${root}`;
    for (const other of deps.alongside ?? []) {
      attempt(() => deps.jobLog(formatJobLine({ edge: 'end', kind: other.kind, root: other.root, ok: false, error }, now())));
      cleanUpEndedJob(other.kind, other.root, pid, coldBuildDatabases.isOurs);
    }
    attempt(deps.beforeExit);
    deps.exit(JOB_LIMIT_EXIT_CODE);
  };
  logAndMark();
  if (killAll) return killAll().then(exitBuilder);
  exitBuilder();
  return Promise.resolve();
}
