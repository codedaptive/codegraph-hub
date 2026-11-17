/**
 * The builder process's ended jobs: each (root, kind) whose job was ended over a limit (./job-limits.ts) and
 * so must not run again on its own. This is module state of the process, loaded once at builder start from
 * ./ended-jobs-file.ts and added to as jobs are ended; only a successful `codegraph index` or `codegraph init`
 * of a root clears it. Roots compare by their canonical spelling, so two spellings of one root are one entry.
 * The one clear listener (the builder's is set in ./main.ts) removes the root's lines from the file as well,
 * so a clear outlasts a restart.
 */
import { canonicalProjectRoot } from '../../../directory';
import type { EndedJob } from './ended-job';
import type { JobKind } from './queue';

/** Entries keyed by canonical root, then kind. */
const byRoot = new Map<string, Map<JobKind, EndedJob>>();
let clearListener: ((root: string) => void) | undefined;

export const endedJobs = {
  has(root: string, kind: JobKind): boolean {
    return byRoot.get(canonicalProjectRoot(root))?.has(kind) ?? false;
  },
  find(root: string, kind: JobKind): EndedJob | undefined {
    return byRoot.get(canonicalProjectRoot(root))?.get(kind);
  },
  /**
   * The mark at exactly `root` (no ancestor search): the one of the kind first added for it, a `vacuum` mark
   * passed over (a VACUUM stopped over a limit leaves the index whole: SQLite rolls it back).
   */
  findAt(root: string): EndedJob | undefined {
    const kinds = byRoot.get(canonicalProjectRoot(root))?.values() ?? [];
    for (const job of kinds) if (job.kind !== 'vacuum') return job;
    return undefined;
  },
  add(job: EndedJob): void {
    const canonical = canonicalProjectRoot(job.root);
    const kinds = byRoot.get(canonical) ?? new Map<JobKind, EndedJob>();
    kinds.set(job.kind, job);
    byRoot.set(canonical, kinds);
  },
  /** Forgets every kind of `root`'s ended jobs, then calls the clear listener; a listener that throws is ignored. */
  clearRoot(root: string): void {
    byRoot.delete(canonicalProjectRoot(root));
    try {
      clearListener?.(root);
    } catch {
      // The marks are gone from this process; only the listener's copy (the file) may keep them.
    }
  },
  /** Sets the one listener clearRoot calls with the root as given; a second call replaces it. */
  onClearRoot(listener: (root: string) => void): void {
    clearListener = listener;
  },
  replaceAll(jobs: readonly EndedJob[]): void {
    byRoot.clear();
    for (const job of jobs) endedJobs.add(job);
  },
};
