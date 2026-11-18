/**
 * Ends the builder over a job that went past a limit (./job-watchdog.ts finds it). Jobs run inside the builder's
 * process and cannot be interrupted halfway, so the process itself exits: it logs the `job limit` line, writes
 * the job's mark (./ended-jobs-file.ts) so the restarted builder refuses it, rolls back a partial cold build,
 * removes a seed's staging copy, releases the root's locks it holds, and exits with code 75. The server's client
 * restarts it.
 *
 * The builder runs a lane per repository plus two bypass slots, all in this one process, so other jobs may be
 * running beside the over-limit one, and the exit ends them too. Each gets a failed `job end` line naming the
 * over-limit job, and the same cleanup (its partial cold build rolled back, its seed staging removed, its locks
 * released), but no mark: it was not over a limit, so it runs again only when something asks for it. Only the
 * over-limit job is marked, so nothing retries it automatically.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../../../directory';
import { getWriterPidPath, readWriterLock } from '../../../mcp/writer-lock';
import { coldBuildDatabases } from '../worktree-lifecycle/cold-build-database';
import { seedStagingPid } from '../worktree-lifecycle/seed-staging-pid';
import type { EndedJobsFile } from './ended-jobs-file';
import { formatLimitLine } from './job-limit-line';
import type { LimitBreach } from './limit-breach';
import { formatJobLine, type JobKind } from './queue';

/** EX_TEMPFAIL (sysexits.h): the builder ended itself over a job, and a restart is the expected answer. */
const JOB_LIMIT_EXIT_CODE = 75;

/** Run one step; a failure never stops the steps after it or the exit. */
function attempt(step: () => void): void {
  try {
    step();
  } catch {
    // Best-effort: the builder exits whatever this step left.
  }
}

function lockNamesPid(root: string, lockName: 'rebuild.pid' | 'writer.pid', pid: number): boolean {
  return readWriterLock(root, lockName)?.pid === pid;
}

/**
 * Removes the cold build's partial database, only while `rebuild.pid` names `pid` (no reader has opened it) and
 * the file is the one the running cold build of `root` created (./cold-build-database.ts). A database a user's
 * `codegraph init` made (it takes no `rebuild.pid`), or a breach before the build's init returned, keeps it.
 */
function rollBackColdBuild(root: string, pid: number): void {
  const dbFile = path.join(getCodeGraphDir(root), 'codegraph.db');
  if (!lockNamesPid(root, 'rebuild.pid', pid) || !coldBuildDatabases.isOurs(root, dbFile)) return;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    attempt(() => fs.rmSync(`${dbFile}${suffix}`, { force: true }));
  }
}

/**
 * Removes the seed's staging copies of `root` (../worktree-lifecycle/seed-staging-pid.ts) that carry `pid`. The
 * seed ran in this process, so its staging copy, a whole index copy, names this pid; nothing else would remove it.
 */
function removeSeedStaging(root: string, pid: number): void {
  const dir = getCodeGraphDir(root);
  for (const name of fs.readdirSync(dir)) {
    if (seedStagingPid(name) === pid) attempt(() => fs.rmSync(path.join(dir, name), { force: true }));
  }
}

/**
 * What a job the exit ends leaves behind: a cold build's partial database, a seed's staging copy, and the root's
 * locks. A lock is removed only where it names `pid` (releaseWriterLock compares with process.pid, so `pid` is
 * compared here). An `index` or `init` keeps its database: it may be a user's.
 */
function cleanUpJob(kind: JobKind, root: string, pid: number): void {
  if (kind === 'cold-build') attempt(() => rollBackColdBuild(root, pid));
  if (kind === 'seed') attempt(() => removeSeedStaging(root, pid));
  for (const lockName of ['rebuild.pid', 'writer.pid'] as const) {
    attempt(() => {
      if (lockNamesPid(root, lockName, pid)) fs.unlinkSync(getWriterPidPath(root, lockName));
    });
  }
}

/** Log and mark the over-limit job, end each job `alongside` it without a mark, clean up each, then exit; see the header. */
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
    /** The jobs running beside the over-limit one, which the exit ends too. */
    alongside?: readonly { kind: JobKind; root: string }[];
  },
): void {
  const pid = deps.pid ?? process.pid;
  const now = deps.now ?? (() => new Date());
  const { root, kind } = job;
  attempt(() => deps.jobLog(formatLimitLine(job, breach, now())));
  attempt(() => deps.endedFile.append({ root, kind, limit: breach.limit, at: now().toISOString() }));
  cleanUpJob(kind, root, pid);
  const error = `the builder ended over the ${breach.limit} limit of ${kind} ${root}`;
  for (const other of deps.alongside ?? []) {
    attempt(() => deps.jobLog(formatJobLine({ edge: 'end', kind: other.kind, root: other.root, ok: false, error }, now())));
    cleanUpJob(other.kind, other.root, pid);
  }
  attempt(deps.beforeExit);
  deps.exit(JOB_LIMIT_EXIT_CODE);
}
