/**
 * runSyncJob (src/extensions/host/builder/run-sync-job.ts), with a fake runner: the spec names the sync body with
 * `paths` only when given, the SyncResult comes back, progress is forwarded in order, and a `locked` answer is
 * thrown as a LockUnavailableError carrying the body's message.
 */
import { describe, expect, it } from 'vitest';
import { LockUnavailableError } from '../../../src/errors';
import type { JobRunner } from '../../../src/extensions/host/builder/job-runner-type';
import type { JobSpec } from '../../../src/extensions/host/builder/job-spec-type';
import { runSyncJob } from '../../../src/extensions/host/builder/run-sync-job';

const syncResult = { filesChecked: 4, filesAdded: 1, filesModified: 2, filesRemoved: 0, nodesUpdated: 3, durationMs: 9 };

function fakeRunner(payloads: unknown[], value: unknown): { runJob: JobRunner; specs: JobSpec[]; ids: number[] } {
  const specs: JobSpec[] = [];
  const ids: number[] = [];
  const runJob: JobRunner = async (id, spec, onProgress) => {
    ids.push(id);
    specs.push(spec);
    for (const payload of payloads) onProgress?.(payload);
    return value;
  };
  return { runJob, specs, ids };
}

describe('runSyncJob', () => {
  it('runs the sync body for the job id with the root alone and answers the SyncResult', async () => {
    const { runJob, specs, ids } = fakeRunner([], { result: syncResult });
    await expect(runSyncJob(runJob, 42, 'catch-up', '/repo')).resolves.toEqual(syncResult);
    expect(ids).toEqual([42]);
    expect(specs[0]).toMatchObject({ kind: 'catch-up', root: '/repo', export: 'syncRootBody', args: { root: '/repo' } });
    expect(specs[0].args).not.toHaveProperty('paths');
  });

  it('passes the watcher paths to the body', async () => {
    const { runJob, specs } = fakeRunner([], { result: syncResult });
    await runSyncJob(runJob, 1, 'watch-sync', '/repo', { paths: ['a.ts', 'b/c.ts'] });
    expect(specs[0].args).toEqual({ root: '/repo', paths: ['a.ts', 'b/c.ts'] });
  });

  it('forwards the progress payloads in order', async () => {
    const { runJob } = fakeRunner([
      { phase: 'scanning', current: 0, total: 2 },
      { phase: 'parsing', current: 1, total: 2 },
    ], { result: syncResult });
    const seen: unknown[] = [];
    await runSyncJob(runJob, 1, 'sync', '/repo', { onProgress: (progress) => seen.push(progress) });
    expect(seen).toEqual([{ phase: 'scanning', current: 0, total: 2 }, { phase: 'parsing', current: 1, total: 2 }]);
  });

  it('throws a locked answer as a LockUnavailableError with its message', async () => {
    const { runJob } = fakeRunner([], { locked: 'Sync could not acquire the file lock' });
    const outcome = runSyncJob(runJob, 1, 'sync', '/repo');
    await expect(outcome).rejects.toBeInstanceOf(LockUnavailableError);
    await expect(outcome).rejects.toThrow('Sync could not acquire the file lock');
  });
});
