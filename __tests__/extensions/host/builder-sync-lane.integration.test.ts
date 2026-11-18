import { inProcessJobRunner } from './helpers/in-process-job-runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../../../src/index';
import { BuilderService } from '../../../src/extensions/host/builder/service';
import type { BuilderToServer } from '../../../src/extensions/host/builder/protocol';

async function indexedProject(root: string): Promise<void> {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'src', 'base.ts'), 'export function baseSymbol() { return 1; }\n');
  const graph = await CodeGraph.init(root);
  try { await graph.indexAll(); } finally { graph.close(); }
}

describe('builder queue lanes', { timeout: 60_000 }, () => {
  let workspace: string;
  let service: BuilderService;
  let lines: string[];
  let sent: BuilderToServer[];

  beforeEach(() => {
    // '/tmp' keeps the workspace outside any git worktree whatever TMPDIR points at; Windows has no '/tmp'.
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cg-sync-lane-')));
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    lines = [];
    sent = [];
    service = new BuilderService({ runJob: inProcessJobRunner().runJob,
      send: (message) => { sent.push(message); },
      jobLog: (line) => { lines.push(line); },
      log: () => {},
      watchOptions: () => ({ debounceMs: 100 }),
      housekeeping: false,
    });
  });

  afterEach(async () => {
    await service.stop(0);
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('a sync of root B answers while a cold build of root A is held running', async () => {
    const a = path.join(workspace, 'a');
    const b = path.join(workspace, 'b');
    fs.mkdirSync(a);
    execFileSync('git', ['init', '-q'], { cwd: a, stdio: 'ignore' });
    await indexedProject(b);
    expect(await service.ensure(b)).toEqual({ kind: 'ready', root: b });
    await service.holders.caughtUp(b);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cold = service.queue.enqueue('cold-build', a, () => gate);
    try {
      expect(lines.some((line) => line.includes(` job start cold-build ${a}`))).toBe(true);
      fs.writeFileSync(path.join(b, 'src', 'base.ts'), 'export function addedSymbol() { return 2; }\n');
      const sync = service.handle({ id: 41, op: 'sync', root: b });
      await Promise.resolve();
      expect(lines.some((line) => line.includes(` job start sync ${b}`))).toBe(true);
      expect(lines.some((line) => line.includes(` job end cold-build ${a}`))).toBe(false);
      await sync;
      expect(sent).toContainEqual({ id: 41, ok: true, result: { filesChanged: 1 } });
    } finally {
      release();
      await cold;
      await service.queue.whenIdle();
    }
  });

  it('two jobs of the same root never write at once', async () => {
    const b = path.join(workspace, 'b');
    await indexedProject(b);
    expect(await service.ensure(b)).toEqual({ kind: 'ready', root: b });
    await service.holders.caughtUp(b);
    let releaseCold = () => {};
    const coldGate = new Promise<void>((resolve) => { releaseCold = resolve; });
    const cold = service.queue.enqueue('index', b, () => coldGate);
    try {
      const sync = service.handle({ id: 42, op: 'sync', root: b });
      await Promise.resolve();
      expect(lines.some((line) => line.includes(` job start sync ${b}`))).toBe(false);
      releaseCold();
      await cold;
      await sync;
      expect(lines.some((line) => line.includes(` job start sync ${b}`))).toBe(true);
      expect(sent).toContainEqual({ id: 42, ok: true, result: { filesChanged: 0 } });
    } finally {
      releaseCold();
      await cold;
    }

    let releaseSync = () => {};
    const syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
    const heldSync = service.queue.enqueue('sync', b, () => syncGate);
    const index = service.queue.enqueue('index', b, async () => undefined);
    try {
      expect(lines.filter((line) => line.includes(` job start index ${b}`))).toHaveLength(1);
      releaseSync();
      await heldSync;
      await index;
      expect(lines.filter((line) => line.includes(` job start index ${b}`))).toHaveLength(2);
    } finally {
      releaseSync();
      await heldSync;
      await index;
    }
  });
});
