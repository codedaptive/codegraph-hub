/**
 * The builder's `ensure` answer, told about a job ended over a limit (./ended-jobs.ts). The mark of the
 * nearest root at or above the call's path rides on a `none` answer as `ended`, so the server can tell the
 * call why there is no index and what clears it. A `building` answer under a root whose cold build was ended
 * becomes that `none`: the builder refuses the ended cold build, so "building" would never come true.
 * `ready`, `seeded` and a pending `none` are answered as they are.
 */
import * as path from 'path';
import { canonicalProjectRoot } from '../../../directory';
import type { EnsureOutcome } from './client';
import type { EndedJob } from './ended-job';
import { endedJobs } from './ended-jobs';

export function withEndedJob(outcome: EnsureOutcome, projectPath: string): EnsureOutcome {
  if (outcome.kind === 'none' && !outcome.pending) {
    const mark = nearestMark(projectPath, (dir) => endedJobs.findAt(dir));
    return mark ? { ...outcome, ended: endedOf(mark) } : outcome;
  }
  if (outcome.kind === 'building') {
    const mark = nearestMark(outcome.root, (dir) => endedJobs.find(dir, 'cold-build'));
    return mark ? { kind: 'none', ended: endedOf(mark) } : outcome;
  }
  return outcome;
}

/** The first mark `find` gives for `start` or one of its ancestors, deepest first. */
function nearestMark(start: string, find: (dir: string) => EndedJob | undefined): EndedJob | undefined {
  for (let dir = canonicalProjectRoot(start); ; dir = path.dirname(dir)) {
    const mark = find(dir);
    if (mark || path.dirname(dir) === dir) return mark;
  }
}

function endedOf(mark: EndedJob): { root: string; kind: EndedJob['kind']; limit: EndedJob['limit'] } {
  return { root: mark.root, kind: mark.kind, limit: mark.limit };
}
