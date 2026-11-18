import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../../../src/index';
import { BuilderService } from '../../../src/extensions/host/builder/service';
import type { BuilderToServer, CliIndexMode } from '../../../src/extensions/host/builder/protocol';
import type { JobSpec } from '../../../src/extensions/host/builder/job-spec-type';
import { readWriterLock } from '../../../src/mcp/writer-lock';
import { inProcessJobRunner } from './helpers/in-process-job-runner';

const indexResult = { success: true, filesIndexed: 1, filesSkipped: 0, filesErrored: 0, nodesCreated: 1, edgesCreated: 0, errors: [], durationMs: 0 };

describe('CLI jobs through the job runner', { timeout: 90_000 }, () => {
  let base: string;
  let root: string;
  let service: BuilderService;
  let messages: BuilderToServer[];

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-job-runner-')));
    root = path.join(base, 'repo');
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, 'first.ts'), 'export const first = 1;\n');
    execFileSync('git', ['-C', root, 'add', 'first.ts']);
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(base, 'state'));
    vi.stubEnv('CODEGRAPH_NO_WATCH', '1');
    messages = [];
  });

  afterEach(async () => {
    await service?.stop(0);
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  });

  function start(runJob: (id: number, spec: JobSpec, progress?: (payload: unknown) => void) => Promise<unknown>): void {
    service = new BuilderService({
      send: (message) => messages.push(message), jobLog: () => undefined, log: () => undefined,
      watchOptions: () => ({}), housekeeping: false, ...{ runJob },
    });
  }

  async function indexRoot(): Promise<void> {
    const cg = await CodeGraph.init(root);
    try { await cg.indexAll(); } finally { cg.close(); }
  }

  it.each([
    { mode: 'init', kind: 'init', lease: false },
    { mode: 'rebuild', kind: 'index', lease: true },
    { mode: 'reindex-leased', kind: 'index', lease: true },
    { mode: 'reindex', kind: 'index', lease: false },
  ] satisfies Array<{ mode: CliIndexMode; kind: string; lease: boolean }>)('runs CLI $mode with job kind $kind and the queue job id', async ({ mode, kind, lease }) => {
    if (mode !== 'init') await indexRoot();
    const runner = inProcessJobRunner();
    const runningIds: number[] = [];
    start((id, spec, progress) => {
      runningIds.push(service.queue.runningJobs().find((job) => job.id === id)?.id ?? -1);
      return runner.runJob(id, spec, progress);
    });
    if (lease) await service.handle({ id: 1, op: 'fence', root });
    await service.handle({ id: 2, op: 'cliIndex', root, mode });
    expect(messages).toContainEqual(expect.objectContaining({ id: 2, ok: true }));
    expect(runner.specs).toHaveLength(1);
    expect(runner.specs[0]).toMatchObject({ kind, root, writerPid: process.pid });
    expect(runningIds).toEqual([1]);
    if (lease) await service.handle({ id: 3, op: 'unfence', root });
  });

  it('pushes child progress payloads in order as request events', async () => {
    start(async (_id, _spec, progress) => {
      progress?.({ phase: 'scanning', current: 0, total: 1 });
      progress?.({ phase: 'parsing', current: 1, total: 1 });
      return indexResult;
    });
    await service.handle({ id: 7, op: 'cliIndex', root, mode: 'init' });
    expect(messages.filter((message) => 'op' in message && message.op === 'requestEvent' && message.event.kind === 'progress')).toEqual([
      { op: 'requestEvent', requestId: 7, event: { kind: 'progress', progress: { phase: 'scanning', current: 0, total: 1 } } },
      { op: 'requestEvent', requestId: 7, event: { kind: 'progress', progress: { phase: 'parsing', current: 1, total: 1 } } },
    ]);
  });

  it('pushes verbose child log payloads as ordered log events', async () => {
    start(async (_id, _spec, progress) => {
      progress?.({ log: 'first line' });
      progress?.({ log: 'second line' });
      return indexResult;
    });
    await service.handle({ id: 8, op: 'cliIndex', root, mode: 'init', verbose: true });
    expect(messages.filter((message) => 'op' in message && message.op === 'requestEvent' && message.event.kind === 'log')).toEqual([
      { op: 'requestEvent', requestId: 8, event: { kind: 'log', line: 'first line' } },
      { op: 'requestEvent', requestId: 8, event: { kind: 'log', line: 'second line' } },
    ]);
  });

  it('takes rebuild writer ownership in the parent before running the child and releases it on unfence', async () => {
    await indexRoot();
    const runner = inProcessJobRunner();
    let during: ReturnType<typeof readWriterLock> = null;
    start((id, spec, progress) => {
      during = readWriterLock(root);
      return runner.runJob(id, spec, progress);
    });
    await service.handle({ id: 9, op: 'fence', root });
    await service.handle({ id: 10, op: 'cliIndex', root, mode: 'rebuild' });
    expect(messages).toContainEqual(expect.objectContaining({ id: 10, ok: true }));
    expect(during).toMatchObject({ pid: process.pid, mode: 'rebuild' });
    expect(readWriterLock(root)).toMatchObject({ pid: process.pid, mode: 'rebuild' });
    await service.handle({ id: 11, op: 'unfence', root });
    expect(readWriterLock(root)).toBeNull();
  });

  it('runs cliSync under the held writer lock without replacing it', async () => {
    await indexRoot();
    const runner = inProcessJobRunner();
    let during: ReturnType<typeof readWriterLock> = null;
    start((id, spec, progress) => {
      if (spec.kind === 'sync') during = readWriterLock(root);
      return runner.runJob(id, spec, progress);
    });
    expect(await service.ensure(root)).toEqual({ kind: 'ready', root });
    await service.holders.caughtUp(root);
    fs.writeFileSync(path.join(root, 'second.ts'), 'export const second = 2;\n');
    execFileSync('git', ['-C', root, 'add', 'second.ts']);
    await service.handle({ id: 12, op: 'cliSync', root });
    expect(messages).toContainEqual(expect.objectContaining({ id: 12, ok: true, result: expect.objectContaining({ filesAdded: 1 }) }));
    expect(runner.specs.at(-1)).toMatchObject({ kind: 'sync', root, writerPid: process.pid });
    expect(during).toMatchObject({ pid: process.pid, mode: 'builder' });
    expect(readWriterLock(root)).toMatchObject({ pid: process.pid, mode: 'builder' });
  });
});
