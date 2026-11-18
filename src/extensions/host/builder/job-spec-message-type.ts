/** The one message the builder sends a job's child process (./job-supervisor.ts to ./job-child-main.ts): the job to run. */
import type { JobSpec } from './job-spec-type';

export interface JobSpecMessage {
  type: 'spec';
  spec: JobSpec;
}
