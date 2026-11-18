/**
 * What a sync job's body (./sync-root-body.ts) answers: the SyncResult as JSON, or `locked` with the message of
 * the LockUnavailableError the sync threw. An error crosses the job's IPC as a plain Error with its message and
 * name, never an instance of its class, so the lock contention travels as a result and the builder throws it
 * again as a real LockUnavailableError (./run-sync-job.ts): a hold's catch-up retries on it and the FileWatcher
 * parks on it (both match by instanceof), and the CLI is told it by name.
 */
import type { SyncResult } from '../../../extraction';

export type SyncJobOutcome = { result: SyncResult } | { locked: string };
