import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import CodeGraph from '../../../src/index';
import { readWriterLock } from '../../../src/mcp/writer-lock';
import { BuilderService } from '../../../src/extensions/host/builder/service';

let root: string;
let fencedRoot: string;
let service: BuilderService;

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-service-stop-')));
  fencedRoot = path.join(root, 'fenced');
  fs.mkdirSync(fencedRoot);
  execFileSync('git', ['init', '-q'], { cwd: root });
  CodeGraph.initSync(root).close();
  vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(root, 'state'));
  service = new BuilderService({ send: () => undefined, jobLog: () => undefined, log: () => undefined, watchOptions: () => ({}), housekeeping: false });
  await service.ensure(root);
  await service.holders.caughtUp(root);
  service.fences.fence(fencedRoot);
});

afterEach(async () => {
  await service?.stop(0);
  vi.unstubAllEnvs();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('BuilderService stop afterGrace', () => {
  it('closes the queue before afterGrace and closes holds and fences afterward', async () => {
    const observations: unknown[] = [];
    await Reflect.apply(service.stop, service, [1_000, async () => {
      try {
        await service.queue.enqueue('sync', root, async () => { observations.push('job started'); });
      } catch (error) {
        observations.push(error instanceof Error ? error.message : String(error));
      }
      observations.push(service.holders.has(root), readWriterLock(root)?.pid === process.pid, service.fences.isFenced(fencedRoot));
    }]);
    expect(observations).toEqual(['the index builder is stopping', true, true, true]);
    expect(service.holders.has(root)).toBe(false);
    expect(readWriterLock(root)).toBeNull();
    expect(service.fences.isFenced(fencedRoot)).toBe(false);
    expect(readWriterLock(fencedRoot, 'rebuild.pid')).toBeNull();
  });

  it('lets a running job finish within the grace before afterGrace', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    const job = service.queue.enqueue('sync', root, async () => { await gate; events.push('job finished'); });
    const stopping = Promise.resolve(Reflect.apply(service.stop, service, [1_000, async () => { events.push('after grace'); }]));
    release();
    await Promise.all([job, stopping]);
    expect(events).toEqual(['job finished', 'after grace']);
  });

  it('runs afterGrace when a running job outlasts the grace', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const job = service.queue.enqueue('sync', root, async () => { await gate; });
    const observations: string[] = [];
    try {
      await Reflect.apply(service.stop, service, [10, async () => {
        if (service.queue.runningJobs().length === 1) observations.push('job still running');
        release();
        await job;
      }]);
      expect(observations).toEqual(['job still running']);
    } finally {
      release();
      await job;
    }
  });

  it('awaits afterGrace before closing holds', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let called = false;
    let finished = false;
    const stopping = Promise.resolve(Reflect.apply(service.stop, service, [1_000, async () => { called = true; markStarted(); await gate; }]))
      .then(() => { finished = true; });
    try {
      await Promise.race([started, stopping]);
      expect(called).toBe(true);
      expect(finished).toBe(false);
      expect(service.holders.has(root)).toBe(true);
    } finally {
      release();
      await stopping;
    }
    expect(service.holders.has(root)).toBe(false);
  });

  it('closes holds and releases fences when afterGrace throws', async () => {
    let called = false;
    await Promise.allSettled([Promise.resolve(Reflect.apply(service.stop, service, [1_000, async () => {
      called = true;
      throw new Error('kill failed');
    }]))]);
    expect(called).toBe(true);
    expect(service.holders.has(root)).toBe(false);
    expect(readWriterLock(root)).toBeNull();
    expect(service.fences.isFenced(fencedRoot)).toBe(false);
    expect(readWriterLock(fencedRoot, 'rebuild.pid')).toBeNull();
  });
});
