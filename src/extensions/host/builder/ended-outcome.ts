/**
 * The builder's `ensure` answer, told about a job ended over a limit (./ended-jobs.ts). The mark of the
 * nearest root at or above the call's path rides on a `none` answer as `ended`, so the server can tell the
 * call why there is no index and what clears it. A `building` answer for a root whose own cold build was
 * ended becomes that `none`: the builder refuses that cold build, so "building" would never come true. An
 * ancestor's mark leaves a nested root's build alone, since only the marked root's own cold build is refused.
 * `ready`, `seeded` and a pending `none` are answered as they are.
 */
import * as path from 'path';
import { canonicalProjectRoot } from '../../../directory';
import type { EnsureOutcome } from './client';
import type { EndedJob } from './ended-job';
import { endedJobs } from './ended-jobs';

export function withEndedJob(outcome: EnsureOutcome, projectPath: string): EnsureOutcome {
  if (outcome.kind === 'none' && !outcome.pending) {
    const mark = nearestMark(projectPath);
    return mark ? { ...outcome, ended: endedOf(mark) } : outcome;
  }
  if (outcome.kind === 'building') {
    const mark = endedJobs.find(outcome.root, 'cold-build');
    return mark ? { kind: 'none', ended: endedOf(mark) } : outcome;
  }
  return outcome;
}

/**
 * The mark at `start` or at its nearest ancestor that has one, deepest first. A `vacuum` mark is passed over
 * (endedJobs.findAt): a stopped VACUUM leaves the index whole, so it explains no missing index, and the
 * directory's ancestors are still looked at.
 */
function nearestMark(start: string): EndedJob | undefined {
  for (let dir = canonicalProjectRoot(start); ; dir = path.dirname(dir)) {
    const mark = endedJobs.findAt(dir);
    if (mark || path.dirname(dir) === dir) return mark;
  }
}

function endedOf(mark: EndedJob): { root: string; kind: EndedJob['kind']; limit: EndedJob['limit'] } {
  return { root: mark.root, kind: mark.kind, limit: mark.limit };
}
