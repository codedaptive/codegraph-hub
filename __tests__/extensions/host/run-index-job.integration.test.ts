/**
 * runIndexJob (src/extensions/host/builder/run-index-job.ts), with a fake runner: the job's payloads become the
 * request's events in order (`{log}` a `log` event, anything else a `progress` event), an init announces
 * `initialized` before its first payload or its result, and a body that fails before any payload sends nothing.
 */
import { describe, expect, it } from 'vitest';
import type { IndexWriteEvent } from '../../../src/extensions/host/builder/cli-wire';
import type { JobRunner } from '../../../src/extensions/host/builder/job-runner-type';
import type { JobSpec } from '../../../src/extensions/host/builder/job-spec-type';
import { runIndexJob } from '../../../src/extensions/host/builder/run-index-job';

const indexResult = { success: true, filesIndexed: 2, filesSkipped: 0, filesErrored: 0, nodesCreated: 3, edgesCreated: 1, errors: [], durationMs: 5 };

function fakeRunner(payloads: unknown[], outcome: { value?: unknown; error?: Error }): { runJob: JobRunner; calls: Array<{ id: number; spec: JobSpec }> } {
  const calls: Array<{ id: number; spec: JobSpec }> = [];
  const runJob: JobRunner = async (id, spec, onProgress) => {
    calls.push({ id, spec });
    for (const payload of payloads) onProgress?.(payload);
    if (outcome.error) throw outcome.error;
    return outcome.value;
  };
  return { runJob, calls };
}

describe('runIndexJob', () => {
  it('announces initialized before the first payload of an init and maps log and progress payloads in order', async () => {
    const { runJob, calls } = fakeRunner([
      { phase: 'scanning', current: 0, total: 2 },
      { log: '[worker] started' },
      { phase: 'parsing', current: 2, total: 2 },
    ], { value: indexResult });
    const events: IndexWriteEvent[] = [];
    const result = await runIndexJob(runJob, 17, { root: '/repo', open: 'init', verbose: true }, (event) => events.push(event));
    expect(result).toEqual(indexResult);
    expect(events).toEqual([
      { kind: 'initialized' },
      { kind: 'progress', progress: { phase: 'scanning', current: 0, total: 2 } },
      { kind: 'log', line: '[worker] started' },
      { kind: 'progress', progress: { phase: 'parsing', current: 2, total: 2 } },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe(17);
    expect(calls[0].spec).toMatchObject({
      kind: 'init', root: '/repo', export: 'indexRootBody', args: { root: '/repo', open: 'init', verbose: true },
    });
  });

  it('announces initialized before the result of an init that sent no payload', async () => {
    const { runJob } = fakeRunner([], { value: indexResult });
    const events: IndexWriteEvent[] = [];
    await expect(runIndexJob(runJob, 1, { root: '/repo', open: 'init', verbose: false }, (event) => events.push(event))).resolves.toEqual(indexResult);
    expect(events).toEqual([{ kind: 'initialized' }]);
  });

  it('runs a recreate or an open as an index job and sends no initialized', async () => {
    for (const open of ['recreate', 'open'] as const) {
      const { runJob, calls } = fakeRunner([{ phase: 'scanning', current: 0, total: 1 }], { value: indexResult });
      const events: IndexWriteEvent[] = [];
      await runIndexJob(runJob, 2, { root: '/repo', open, verbose: false }, (event) => events.push(event));
      expect(calls[0].spec.kind).toBe('index');
      expect(events).toEqual([{ kind: 'progress', progress: { phase: 'scanning', current: 0, total: 1 } }]);
    }
  });

  it('rejects with the body error and sends no initialized when the init fails before any payload', async () => {
    const { runJob } = fakeRunner([], { error: new Error('CodeGraph already initialized in /repo') });
    const events: IndexWriteEvent[] = [];
    await expect(runIndexJob(runJob, 3, { root: '/repo', open: 'init', verbose: false }, (event) => events.push(event)))
      .rejects.toThrow('CodeGraph already initialized in /repo');
    expect(events).toEqual([]);
  });
});
