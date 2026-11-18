/**
 * console.log turned into lines for the jobs that ask for them (a verbose `index` or `init` job, ./cli-jobs.ts).
 * With `verbose` the engine writes its `[worker] ...` and `[wal-valve] ...` diagnostics with console.log
 * (src/extraction/index.ts, src/index.ts), which a CLI running the index itself shows on its stdout; in the
 * builder, whose stdout is not connected to anything (the server forks it with stdio 'ignore', ./client.ts),
 * they go to the CLI as events instead.
 *
 * console.log is one global, and jobs of different git repositories run at once in this process, so captures
 * can overlap. One patch is installed while any capture is active, and the true original is put back when the
 * last one ends, in whatever order they end. A line logged while several captures are active goes to every one
 * of them: the lines of overlapping verbose jobs cannot be told apart in one process.
 */
import { format } from 'util';

interface Capture {
  onLine: (line: string) => void;
}

const active = new Set<Capture>();
let original: typeof console.log | null = null;

/** Run `job` with every console.log line sent to `onLine`, and end the capture when it ends, whatever way. */
export async function capturingLog<T>(onLine: (line: string) => void, job: () => Promise<T>): Promise<T> {
  const capture: Capture = { onLine };
  if (active.size === 0) {
    original = console.log;
    console.log = (...args: unknown[]): void => {
      const line = format(...args);
      for (const c of active) c.onLine(line);
    };
  }
  active.add(capture);
  try {
    return await job();
  } finally {
    active.delete(capture);
    if (active.size === 0 && original) {
      console.log = original;
      original = null;
    }
  }
}
