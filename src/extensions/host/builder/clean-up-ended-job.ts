/**
 * What a job ended over a limit (./job-limit-guard.ts), or killed after the stop's grace
 * (./end-jobs-after-grace.ts), leaves behind at its root: a cold build's partial database, a seed's staging copy,
 * and the locks it took. Everything is matched against `pid`, the job's child process: a lock is removed only where
 * it names `pid` (releaseWriterLock compares with process.pid, so `pid` is compared here), so a writer.pid naming
 * the builder (its hold on the root) stays, and a staging copy only where its name carries it. An `index` or
 * `init` keeps its database: it may be a user's.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../../../directory';
import { getWriterPidPath, readWriterLock } from '../../../mcp/writer-lock';
import { seedStagingPid } from '../worktree-lifecycle/seed-staging-pid';
import { attempt } from './attempt';
import type { JobKind } from './queue';

function lockNamesPid(root: string, lockName: 'rebuild.pid' | 'writer.pid', pid: number): boolean {
  return readWriterLock(root, lockName)?.pid === pid;
}

/**
 * Removes the cold build's partial database, only while `rebuild.pid` names `pid` (no reader has opened it) and
 * `isBuildDatabase` says the file is the one the build created. A database a user's `codegraph init` made (it
 * takes no `rebuild.pid`), or a breach before the build's init returned, keeps it.
 */
function rollBackColdBuild(root: string, pid: number, isBuildDatabase: (root: string, dbFile: string) => boolean): void {
  const dbFile = path.join(getCodeGraphDir(root), 'codegraph.db');
  if (!lockNamesPid(root, 'rebuild.pid', pid) || !isBuildDatabase(root, dbFile)) return;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    attempt(() => fs.rmSync(`${dbFile}${suffix}`, { force: true }));
  }
}

/**
 * Removes the seed's staging copies of `root` (../worktree-lifecycle/seed-staging-pid.ts) that carry `pid`: a
 * whole index copy that nothing else would remove.
 */
function removeSeedStaging(root: string, pid: number): void {
  const dir = getCodeGraphDir(root);
  for (const name of fs.readdirSync(dir)) {
    if (seedStagingPid(name) === pid) attempt(() => fs.rmSync(path.join(dir, name), { force: true }));
  }
}

/** Clean up after the `kind` job of `root` that ran in process `pid`; see the header. */
export function cleanUpEndedJob(kind: JobKind, root: string, pid: number, isBuildDatabase: (root: string, dbFile: string) => boolean): void {
  if (kind === 'cold-build') attempt(() => rollBackColdBuild(root, pid, isBuildDatabase));
  if (kind === 'seed') attempt(() => removeSeedStaging(root, pid));
  for (const lockName of ['rebuild.pid', 'writer.pid'] as const) {
    attempt(() => {
      if (lockNamesPid(root, lockName, pid)) fs.unlinkSync(getWriterPidPath(root, lockName));
    });
  }
}
