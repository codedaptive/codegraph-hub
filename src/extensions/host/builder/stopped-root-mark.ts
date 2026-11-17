/**
 * The builder's last stopped-over-limit mark (./ended-job.ts) for one root, read from the builder's file
 * (./ended-jobs-file.ts) at `<state dir>/builder-ended-jobs.jsonl`. A tool answer and the CLI's read path ask
 * on every call, so the parsed file is cached and checked with one stat: while its inode, size and mtime are
 * unchanged it is not read again, and an append or a rewrite (clearRoot renames a new file in) is seen on the
 * next call.
 *
 * The state dir is read, never created (../server/state-dir.ts). Never throws: a missing or invalid state dir
 * or file means no mark, since a mark only adds a note to an answer that is served anyway.
 */
import { statSync } from 'node:fs';
import * as path from 'node:path';
import { canonicalProjectRoot } from '../../../directory';
import { getStateDir } from '../server/state-dir';
import type { EndedJob } from './ended-job';
import { EndedJobsFile } from './ended-jobs-file';

interface Mark {
  canonical: string;
  job: EndedJob;
}

/** The parsed file per path, with the stat identity it was read at. */
const cache = new Map<string, { identity: string; marks: Mark[] }>();

/** The marks in `file`, from the cache while its stat identity is unchanged; [] when it is missing. */
function marksIn(file: string): Mark[] {
  let identity: string;
  try {
    const stat = statSync(file);
    identity = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    cache.delete(file);
    return [];
  }
  const cached = cache.get(file);
  if (cached?.identity === identity) return cached.marks;
  const marks = new EndedJobsFile(file).load().map((job) => ({ canonical: canonicalProjectRoot(job.root), job }));
  cache.set(file, { identity, marks });
  return marks;
}

/** The last mark in file order whose root is `root` (compared canonically), or null. */
export function stoppedRootMark(root: string, stateDir?: string): EndedJob | null {
  let file: string;
  try {
    file = path.join(stateDir ?? getStateDir(), 'builder-ended-jobs.jsonl');
  } catch {
    return null; // An invalid CODEGRAPH_STATE_DIR: no builder can run there, so nothing is marked.
  }
  return marksIn(file).filter((mark) => mark.canonical === canonicalProjectRoot(root)).at(-1)?.job ?? null;
}
