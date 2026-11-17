/**
 * The builder process's ended jobs: each (root, kind) whose job was ended over a limit (./job-limits.ts) and
 * so must not run again on its own. This is module state of the builder process, loaded once at start from
 * ./ended-jobs-file.ts and added to as jobs are ended; only a successful `codegraph index` or `codegraph init`
 * of a root clears it. Roots compare by their canonical spelling, so two spellings of one root are one entry.
 */
import { canonicalProjectRoot } from '../../../directory';
import type { EndedJob } from './ended-job';
import type { JobKind } from './queue';

/** Entries keyed by canonical root, then kind. */
const byRoot = new Map<string, Map<JobKind, EndedJob>>();

export const endedJobs = {
  has(root: string, kind: JobKind): boolean {
    return byRoot.get(canonicalProjectRoot(root))?.has(kind) ?? false;
  },
  find(root: string, kind: JobKind): EndedJob | undefined {
    return byRoot.get(canonicalProjectRoot(root))?.get(kind);
  },
  add(job: EndedJob): void {
    const canonical = canonicalProjectRoot(job.root);
    const kinds = byRoot.get(canonical) ?? new Map<JobKind, EndedJob>();
    kinds.set(job.kind, job);
    byRoot.set(canonical, kinds);
  },
  /** Forgets every kind of `root`'s ended jobs. */
  clearRoot(root: string): void {
    byRoot.delete(canonicalProjectRoot(root));
  },
  replaceAll(jobs: readonly EndedJob[]): void {
    byRoot.clear();
    for (const job of jobs) endedJobs.add(job);
  },
};
