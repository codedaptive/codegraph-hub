/**
 * Ends the builder over a job that went past a limit (./job-watchdog.ts finds it). Jobs run inside the builder's
 * process and cannot be interrupted halfway, so the process itself exits: it logs the `job limit` line, writes
 * the job's mark (./ended-jobs-file.ts) so the restarted builder refuses it, rolls back a partial cold build,
 * releases the root's locks it holds, and exits with {@link JOB_LIMIT_EXIT_CODE}. The server's client restarts it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../../../directory';
import { getWriterPidPath, readWriterLock } from '../../../mcp/writer-lock';
import type { EndedJobsFile } from './ended-jobs-file';
import type { LimitBreach } from './job-limit-breach';
import { formatLimitLine } from './job-limit-line';
import type { JobKind } from './queue';

/** EX_TEMPFAIL (sysexits.h): the builder ended itself over a job, and a restart is the expected answer. */
export const JOB_LIMIT_EXIT_CODE = 75;

export interface EndOverLimitDeps {
  jobLog: (line: string) => void;
  endedFile: Pick<EndedJobsFile, 'append'>;
  beforeExit: () => void;
  exit: (code: number) => void;
  pid?: number;
  now?: () => Date;
}

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
 * Log, mark, roll back and exit; see the header. The database is removed only for a cold build and only while
 * `rebuild.pid` names `pid`: then no reader has opened it, and it is this build's partial one. A lock is removed
 * only where it names `pid` (releaseWriterLock compares with process.pid, so `pid` is compared here).
 */
export function endOverLimit(job: { kind: JobKind; root: string }, breach: LimitBreach, deps: EndOverLimitDeps): void {
  const pid = deps.pid ?? process.pid;
  const now = deps.now ?? (() => new Date());
  const { root, kind } = job;
  attempt(() => deps.jobLog(formatLimitLine(job, breach, now())));
  attempt(() => deps.endedFile.append({ root, kind, limit: breach.limit, at: now().toISOString() }));
  if (kind === 'cold-build') {
    const dbFile = path.join(getCodeGraphDir(root), 'codegraph.db');
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      attempt(() => {
        if (lockNamesPid(root, 'rebuild.pid', pid)) fs.rmSync(`${dbFile}${suffix}`, { force: true });
      });
    }
  }
  for (const lockName of ['rebuild.pid', 'writer.pid'] as const) {
    attempt(() => {
      if (lockNamesPid(root, lockName, pid)) fs.unlinkSync(getWriterPidPath(root, lockName));
    });
  }
  attempt(deps.beforeExit);
  deps.exit(JOB_LIMIT_EXIT_CODE);
}
