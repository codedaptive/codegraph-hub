/**
 * What a stopping builder does with the jobs still running when the exit grace ends (./main.ts, the
 * `afterGrace` of ./service.ts stop): every job's child is killed and waited for, and then each killed job is
 * cleaned up as a job ended at a limit is, by its child's pid (./clean-up-ended-job.ts): a seed's staging copy
 * removed, a cold build's partial database removed when it is the one the child reported creating (or, when the
 * child reported none, unless another live process holds `writer.pid`), and the locks naming the child released.
 * A lock naming the builder (a held root's writer.pid) stays for the hold teardown that follows. No mark is written: the job was not over a limit, and runs again when asked for.
 */
import { cleanUpEndedJob } from './clean-up-ended-job';
import { isCreatedDatabase } from './is-created-database';
import type { JobSupervisor } from './job-supervisor';

export async function endJobsAfterGrace(supervisor: Pick<JobSupervisor, 'killAll'>): Promise<void> {
  for (const job of await supervisor.killAll()) {
    cleanUpEndedJob(job.kind, job.root, job.pid, isCreatedDatabase(job.createdDatabase));
  }
}
