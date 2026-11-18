import { inProcessJobRunner } from './helpers/in-process-job-runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../../../src/index';
import { BuilderService } from '../../../src/extensions/host/builder/service';
import type { BuilderToServer } from '../../../src/extensions/host/builder/protocol';
import { readWriterLock } from '../../../src/mcp/writer-lock';

describe('holder teardown and root jobs', { timeout: 60_000 }, () => {
  let workspace: string;
  let root: string;
  let service: BuilderService;
  let sent: BuilderToServer[];

  beforeEach(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-holder-teardown-')));
    root = path.join(workspace, 'project');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a() { return 1; }\n');
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    vi.stubEnv('CODEGRAPH_NO_WATCH', '1');
    const graph = await CodeGraph.init(root);
    try { await graph.indexAll(); } finally { graph.close(); }
    sent = [];
    service = new BuilderService({ runJob: inProcessJobRunner().runJob,
      send: (message) => { sent.push(message); },
      jobLog: () => {},
      log: () => {},
      watchOptions: () => ({}),
      housekeeping: false,
    });
    expect(await service.ensure(root)).toEqual({ kind: 'ready', root });
    await service.holders.caughtUp(root);
    await service.queue.whenIdle();
    expect(readWriterLock(root)?.pid).toBe(process.pid);
  });

  afterEach(async () => {
    await service.stop(0);
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('keeps the writer lock and waits for a running root job before release', async () => {
    let openGate = () => {};
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    let started = false;
    const job = service.queue.enqueue('vacuum', root, () => {
      started = true;
      return gate;
    });
    let released = false;
    const releasing = service.holders.release(root).then(() => { released = true; });
    try {
      expect(started).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(readWriterLock(root)?.pid, 'writer.pid remains while the job runs').toBe(process.pid);
      expect(released, 'release remains pending while the job runs').toBe(false);
    } finally {
      openGate();
      await job;
      await releasing;
    }
    expect(released).toBe(true);
    expect(readWriterLock(root)).toBeNull();
    expect(fs.existsSync(path.join(root, '.codegraph', 'writer.pid'))).toBe(false);
  });

  it('finishes a rebuild queued behind a job while an ordinary release is waiting', async () => {
    let openGate = () => {};
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const job = service.queue.enqueue('vacuum', root, () => gate);
    let released = false;
    const releasing = service.holders.release(root).then(() => { released = true; });
    let rebuilding: Promise<void> | undefined;
    try {
      await service.handle({ id: 4, op: 'fence', root });
      expect(sent).toContainEqual({ id: 4, ok: true, result: undefined });
      rebuilding = service.handle({ id: 5, op: 'cliIndex', root, mode: 'rebuild' });
      expect(service.queue.waiting()).toBe(1);
      expect(released).toBe(false);
    } finally {
      openGate();
      await job;
    }
    await Promise.all([releasing, rebuilding]);
    expect(released).toBe(true);
    expect(sent).toContainEqual(expect.objectContaining({
      id: 5,
      ok: true,
      result: expect.objectContaining({ success: true, nodesCreated: expect.any(Number) }),
    }));
    await service.handle({ id: 6, op: 'unfence', root });
    expect(sent).toContainEqual({ id: 6, ok: true, result: undefined });
  });

  it('releases an unopened hold while its open job is queued behind another root job', async () => {
    await service.holders.release(root);
    expect(readWriterLock(root)).toBeNull();
    let openGate = () => {};
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const job = service.queue.enqueue('vacuum', root, () => gate);
    const holding = service.holders.hold(root);
    let released = false;
    const releasing = service.holders.release(root).then(() => { released = true; });
    try {
      expect(service.queue.waiting()).toBe(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(released, 'release answers while the other job remains gated').toBe(true);
      expect(readWriterLock(root)).toBeNull();
    } finally {
      openGate();
      await job;
      await holding;
      await releasing;
      await service.queue.whenIdle();
    }
    expect(service.holders.has(root)).toBe(false);
    expect(readWriterLock(root)).toBeNull();
  });

  it('rebuilds a held root under a fence without waiting on its own job', async () => {
    await service.handle({ id: 1, op: 'fence', root });
    expect(sent).toContainEqual({ id: 1, ok: true, result: undefined });

    await service.handle({ id: 2, op: 'cliIndex', root, mode: 'rebuild' });

    expect(sent).toContainEqual(expect.objectContaining({
      id: 2,
      ok: true,
      result: expect.objectContaining({ success: true, nodesCreated: expect.any(Number) }),
    }));
    await service.handle({ id: 3, op: 'unfence', root });
    expect(sent).toContainEqual({ id: 3, ok: true, result: undefined });
  });
});
