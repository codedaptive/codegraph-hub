/**
 * Clears the stopped-over-limit marks of one root after an explicit `codegraph index` or `codegraph init` of it
 * succeeded in the CLI's own process: from this process's ./ended-jobs.ts and from the builder's file
 * (./ended-jobs-file.ts) at `<state dir>/builder-ended-jobs.jsonl`, so the next builder to start runs the
 * root's jobs again. A running builder keeps its in-memory marks until it restarts.
 *
 * The state dir is read, never created (../server/state-dir.ts): no state dir means no builder has ever
 * marked anything. Never throws, since a mark left behind must not fail an index that succeeded.
 */
import * as path from 'path';
import { getStateDir } from '../server/state-dir';
import { endedJobs } from './ended-jobs';
import { EndedJobsFile } from './ended-jobs-file';

/** Removes `root`'s ended jobs from memory and from `<stateDir>/builder-ended-jobs.jsonl`. */
export function clearEndedRoot(root: string, stateDir?: string): void {
  endedJobs.clearRoot(root);
  try {
    new EndedJobsFile(path.join(stateDir ?? getStateDir(), 'builder-ended-jobs.jsonl')).clearRoot(root);
  } catch {
    // An invalid CODEGRAPH_STATE_DIR: the builder cannot run there either, so it has no file to clear.
  }
}
