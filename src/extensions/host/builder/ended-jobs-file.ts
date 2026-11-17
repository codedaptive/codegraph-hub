/**
 * The ended jobs (./ended-jobs.ts) on disk, one JSON line each, so a job ended over a limit stays ended across
 * every builder restart. The builder loads the file at start and appends a line as each job is ended; the lines
 * of a root are removed only when an explicit `codegraph index` or `codegraph init` of it succeeds. The
 * production file is `<state dir>/builder-ended-jobs.jsonl`.
 *
 * No call throws: a lost line only means an ended job may run once more, and a line left behind only means a
 * root stays refused until its next explicit index; neither is a reason to stop the builder or the CLI.
 */
import { appendFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { canonicalProjectRoot } from '../../../directory';
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

/** The job's line, without any field the type does not name. */
function toLine({ root, kind, limit, at }: EndedJob): string {
  return JSON.stringify({ root, kind, limit, at });
}

export class EndedJobsFile {
  constructor(private readonly file: string) {}

  /** Adds one job as a line, creating the file if needed. */
  append(job: EndedJob): void {
    try {
      appendFileSync(this.file, `${toLine(job)}\n`, { mode: 0o600 });
    } catch {
      // The job is still ended in this process; only its survival across a restart is lost.
    }
  }

  /** Every valid job in the file, in file order; [] when there is none or it cannot be read. The file is kept. */
  load(): EndedJob[] {
    return this.read() ?? [];
  }

  /**
   * Rewrites the file without `root`'s lines (roots compare canonically; other lines keep their order),
   * through a temporary file and a rename so a reader sees the old file or the new. Deletes the file when
   * no line is left. A file that cannot be read is left as it is; bad lines go with a rewrite, as load
   * skips them anyway.
   */
  clearRoot(root: string): void {
    const jobs = this.read();
    if (jobs === null) return;
    const canonical = canonicalProjectRoot(root);
    const kept = jobs.filter((job) => canonicalProjectRoot(job.root) !== canonical);
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      if (kept.length === 0) {
        unlinkSync(this.file);
        return;
      }
      writeFileSync(tmp, kept.map((job) => `${toLine(job)}\n`).join(''), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // The marks stay on disk: the root is refused again after a restart until its next explicit index.
    }
  }

  /** The file's valid jobs, or null when it is missing or cannot be read. */
  private read(): EndedJob[] | null {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return null;
    }
    return text.split('\n').flatMap((line) => {
      const job = line.trim() === '' ? null : parseLine(line);
      return job ? [job] : [];
    });
  }
}
