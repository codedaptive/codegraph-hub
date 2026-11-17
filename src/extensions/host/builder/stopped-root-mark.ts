/**
 * The builder's last stopped-over-limit mark (./ended-job.ts) for one root, read from the builder's file
 * (./ended-jobs-file.ts) at `<state dir>/builder-ended-jobs.jsonl`. A tool answer and the CLI's read path ask
 * on every call, so the parsed file is cached and checked with one stat: while its inode, size and mtime are
 * unchanged it is not read again, and an append or a rewrite (clearRoot renames a new file in) is seen on the
 * next call.
 *
 * The state dir is read, never created (../server/state-dir.ts). Never throws: a missing or invalid state dir
 * or file means no mark, since a mark only adds a note to an answer that is served anyway.
 *
 * A `vacuum` mark is passed over: a VACUUM stopped over a limit leaves the index whole (SQLite rolls the VACUUM
 * back), so it is no reason to warn that the index may be incomplete.
 *
 * The root may be passed as a getter. It is called only when the file holds at least one mark (of any root), so
 * with no marks an answer costs no root read; a getter that throws (a closed handle) means no mark.
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

/**
 * The last mark in file order whose root is `root` (compared canonically) and whose kind is not `vacuum`, or
 * null. A `root` getter is called only when the file holds marks; when it throws, the answer is null.
 */
export function stoppedRootMark(root: string | (() => string), stateDir?: string): EndedJob | null {
  let marks: Mark[];
  let canonical: string;
  try {
    // An invalid CODEGRAPH_STATE_DIR throws here: no builder can run there, so nothing is marked.
    marks = marksIn(path.join(stateDir ?? getStateDir(), 'builder-ended-jobs.jsonl'));
    if (marks.length === 0) return null;
    canonical = canonicalProjectRoot(typeof root === 'string' ? root : root());
  } catch {
    return null;
  }
  return marks.filter((mark) => mark.canonical === canonical && mark.job.kind !== 'vacuum').at(-1)?.job ?? null;
}
