import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderSeedHost } from '../../../src/extensions/host/builder/seed-host';
import { JobQueue, type JobEvent } from '../../../src/extensions/host/builder/queue';
import { endedJobs } from '../../../src/extensions/host/builder/ended-jobs';
import type { JobSpec } from '../../../src/extensions/host/builder/job-spec-type';

vi.mock('../../../src/extensions/host/worktree-lifecycle/cold-build', () => ({
  COLD_BUILD_EXIT_BUILT: 0, COLD_BUILD_EXIT_FAILED: 1, COLD_BUILD_EXIT_BUSY: 3, COLD_BUILD_EXIT_LOCKED: 4,
  runColdBuild: async () => 0,
}));

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-seed-host-child-')));
  execFileSync('git', ['init', '-q', root]);
  endedJobs.replaceAll([]);
});
afterEach(() => {
  endedJobs.replaceAll([]);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('seed host cold-build parent prelude', () => {
  it('runs an admitted cold build through the job runner', async () => {
    const runJob = vi.fn(async (_id: number, _spec: JobSpec) => 0);
    const queue = new JobQueue({ loadAverage: () => 0 });
    const host = new BuilderSeedHost(queue, { runJob });
    host.queueColdBuild(root, { realRoot: root });
    await queue.whenIdle();
    expect(runJob).toHaveBeenCalledOnce();
    expect(runJob.mock.calls[0][1]).toMatchObject({ kind: 'cold-build', root });
  });
  it('refuses a cold build marked ended after enqueue without running a child', async () => {
    const runJob = vi.fn(async (_id: number, _spec: JobSpec) => 0);
    const events: JobEvent[] = [];
    const queue = new JobQueue({ loadAverage: () => 0, onEvent: (event) => { events.push(event); } });
    const host = new BuilderSeedHost(queue, { runJob });
    let release: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { started = resolve; });
    const blocker = queue.enqueue('sync', root, async () => { started(); await gate; });
    await active;
    host.queueColdBuild(root, { realRoot: root });
    endedJobs.add({ root, kind: 'cold-build', limit: 'time', at: '2026-11-16T10:00:00.000Z' });
    release();
    await blocker;
    await queue.whenIdle();
    expect(runJob).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ edge: 'end', kind: 'cold-build', root, ok: false }));
  });
});
