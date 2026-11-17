/**
 * The ended jobs (./ended-jobs.ts) on disk, one JSON line each, so a job ended over a limit stays ended when
 * the builder process restarts after it. The builder takes the file at start (read, then deleted) and appends
 * a line as each job is ended; the production file is `<state dir>/builder-ended-jobs.jsonl`.
 *
 * Neither call throws: a lost line only means an ended job may run once more, which is no reason to stop
 * the builder.
 */
import { appendFileSync, readFileSync, unlinkSync } from 'node:fs';
import type { EndedJob } from './ended-job';
import type { JobKind } from './queue';

/** Every job kind, so a line naming any other kind is rejected. The Record makes the compiler keep it whole. */
const KINDS: Record<JobKind, true> = {
  sync: true, 'catch-up': true, 'watch-sync': true, seed: true, 'cold-build': true,
  init: true, index: true, recover: true, open: true,
};

function isJobKind(kind: unknown): kind is JobKind {
  return typeof kind === 'string' && Object.hasOwn(KINDS, kind);
}

/** The line's job, or null when it is not JSON or any field is missing or wrong. */
function parseLine(line: string): EndedJob | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null) return null;
    if (!('root' in value && 'kind' in value && 'limit' in value && 'at' in value)) return null;
    const { root, kind, limit, at } = value;
    if (typeof root !== 'string' || typeof at !== 'string' || !isJobKind(kind)) return null;
    if (limit !== 'time' && limit !== 'rss') return null;
    return { root, kind, limit, at };
  } catch {
    return null;
  }
}

export class EndedJobsFile {
  constructor(private readonly file: string) {}

  /** Adds one job as a line, creating the file if needed. */
  append(job: EndedJob): void {
    const { root, kind, limit, at } = job;
    try {
      appendFileSync(this.file, `${JSON.stringify({ root, kind, limit, at })}\n`, { mode: 0o600 });
    } catch {
      // The job is still ended in this process; only its survival across a restart is lost.
    }
  }

  /** Every valid job in the file, after which the file is deleted; [] when there is none or it cannot be read. */
  take(): EndedJob[] {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    try {
      unlinkSync(this.file);
    } catch {
      // Left in place, the same lines are read again at the next start: the same jobs, still ended.
    }
    return text.split('\n').flatMap((line) => {
      const job = line.trim() === '' ? null : parseLine(line);
      return job ? [job] : [];
    });
  }
}
