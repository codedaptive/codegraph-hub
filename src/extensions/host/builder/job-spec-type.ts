/**
 * What the builder sends a job's child process (./job-supervisor.ts to ./job-child-main.ts): the job, and where its
 * body is. The child loads `module` (an absolute path) and calls its `export` with `args`, which crosses the IPC
 * channel as JSON. `writerPid` is the builder's pid, for a body that must tell the builder's locks from its own.
 */
import type { JobKind } from './queue';

export interface JobSpec {
  kind: JobKind;
  root: string;
  module: string;
  export: string;
  args: unknown;
  writerPid: number;
}
