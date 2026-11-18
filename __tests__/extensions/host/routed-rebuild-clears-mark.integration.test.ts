import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../../../src/index';
import { endedJobs } from '../../../src/extensions/host/builder/ended-jobs';
import type { BuilderToServer } from '../../../src/extensions/host/builder/protocol';
import type { JobRunner } from '../../../src/extensions/host/builder/job-runner-type';
import { BuilderService } from '../../../src/extensions/host/builder/service';
import { inProcessJobRunner } from './helpers/in-process-job-runner';

describe('a routed rebuild of a stopped root', { timeout: 60_000 }, () => {
  let workspace: string;
  let service: BuilderService | undefined;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-routed-stopped-')));
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
  });

  afterEach(async () => {
    await service?.stop(0);
    service = undefined;
    endedJobs.clearRoot(path.join(workspace, 'root'));
    endedJobs.clearRoot(path.join(workspace, 'other'));
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('clears the rebuilt root’s stopped sync mark but preserves another root’s mark', async () => {
    const root = path.join(workspace, 'root');
    const other = path.join(workspace, 'other');
    fs.mkdirSync(root);
    fs.mkdirSync(other);
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(path.join(root, 'first.ts'), 'export function first() { return 1; }\n');
    const cg = await CodeGraph.init(root);
    try { await cg.indexAll(); } finally { cg.close(); }

    const stopped = { root, kind: 'sync' as const, limit: 'time' as const, at: '2026-01-01T00:00:00.000Z' };
    const otherStopped = { ...stopped, root: other };
    endedJobs.add(stopped);
    endedJobs.add(otherStopped);
    expect(endedJobs.find(root, 'sync')).toEqual(stopped);
    expect(endedJobs.find(other, 'sync')).toEqual(otherStopped);

    const sent: BuilderToServer[] = [];
    service = new BuilderService({
      runJob: inProcessJobRunner().runJob,
      send: (message) => { sent.push(message); },
      log: () => {},
      jobLog: () => {},
      housekeeping: false,
    });
    await service.handle({ id: 1, op: 'fence', root, kind: 'index' });
    expect(sent.find((message) => 'id' in message && message.id === 1)).toMatchObject({ id: 1, ok: true });

    await service.handle({ id: 2, op: 'cliIndex', root, mode: 'rebuild' });

    expect(sent.find((message) => 'id' in message && message.id === 2)).toMatchObject({
      id: 2, ok: true, result: { success: true },
    });
    expect(endedJobs.find(root, 'sync')).toBeUndefined();
    expect(endedJobs.find(other, 'sync')).toEqual(otherStopped);
  });

  it.each([
    { mode: 'rebuild', kind: 'index', open: 'recreate' },
    { mode: 'init', kind: 'init', open: 'init' },
  ] as const)('keeps the stopped sync mark when routed $mode resolves with a failed index result', async ({ mode, kind, open }) => {
    const root = path.join(workspace, 'root');
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const stopped = { root, kind: 'sync' as const, limit: 'time' as const, at: '2026-01-01T00:00:00.000Z' };
    endedJobs.add(stopped);
    expect(endedJobs.find(root, 'sync')).toEqual(stopped);

    const runJob = vi.fn<JobRunner>().mockResolvedValue({
      success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0,
      nodesCreated: 0, edgesCreated: 0,
      errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' }],
      durationMs: 0,
    });
    const sent: BuilderToServer[] = [];
    service = new BuilderService({
      runJob,
      send: (message) => { sent.push(message); },
      log: () => {},
      jobLog: () => {},
      watchOptions: () => ({}),
      housekeeping: false,
    });
    if (mode === 'rebuild') {
      await service.handle({ id: 1, op: 'fence', root, kind: 'index' });
      expect(sent.find((message) => 'id' in message && message.id === 1)).toMatchObject({ id: 1, ok: true });
    }

    await service.handle({ id: 2, op: 'cliIndex', root, mode });

    expect(runJob).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ kind, root, args: expect.objectContaining({ open }) }), expect.any(Function));
    expect(sent.find((message) => 'id' in message && message.id === 2)).toMatchObject({
      id: 2, ok: true, result: { success: false, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' }] },
    });
    expect(endedJobs.find(root, 'sync')).toEqual(stopped);
  });
});
