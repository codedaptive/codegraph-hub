/**
 * How the builder runs one job's body: `jobId` is the queue's id of the job, `spec` names the body module and
 * its JSON args (./job-spec-type.ts), `onProgress` gets each payload the body reports, in order. Resolves with
 * the body's JSON result; rejects with its error (its message and name), or when its process ended without one.
 * The builder's runner is ./job-supervisor.ts's `run`, which runs each job in its own child process.
 */
import type { JobSpec } from './job-spec-type';

export type JobRunner = (jobId: number, spec: JobSpec, onProgress?: (payload: unknown) => void) => Promise<unknown>;
