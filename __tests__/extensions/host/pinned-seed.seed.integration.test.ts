import { inProcessJobRunner } from './helpers/in-process-job-runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { isInitialized } from '../../../src/directory';
import * as seedModule from '../../../src/extensions/host/worktree-lifecycle/seed';
import { gitCommonDirAsync } from '../../../src/extensions/host/worktree-lifecycle/git';
import { getRegisteredProject, PROJECT_FLAG_SEEDED, readSeedNonce } from '../../../src/extensions/host/worktree-lifecycle/project-registry';
import { BuilderService } from '../../../src/extensions/host/builder/service';
import { BuilderSeedHost } from '../../../src/extensions/host/builder/seed-host';
import { JobQueue } from '../../../src/extensions/host/builder/queue';
import type { BuilderRequest, BuilderToServer } from '../../../src/extensions/host/builder/protocol';

const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type Outcome = { kind: string; root: string; source?: string; method?: string; reason?: string };
type SeedNow = (root: string, opts?: { automatic?: boolean; wait?: boolean; log?: (line: string) => void }) => Promise<Outcome>;

function seedNow(): SeedNow {
  const fn = (seedModule as unknown as { seedWorktreeNow?: SeedNow }).seedWorktreeNow;
  expect(typeof fn, 'seedWorktreeNow is exported').toBe('function');
  return fn!;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function makeRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'src', 'base.ts'), 'export function baseSymbol() { return 1; }\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}
async function indexDir(dir: string): Promise<void> {
  const cg = await CodeGraph.init(dir);
  try { await cg.indexAll(); } finally { cg.close(); }
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Real Git and SQLite indexes may take over five seconds on the heavily loaded machine.
describe('pinned seed core and builder', { timeout: 60_000 }, () => {
  let workspace: string;
  let main: string;
  let service: BuilderService | undefined;
  let children: ChildProcess[];
  let sent: BuilderToServer[];
  let jobLines: string[];

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pinned-seed-')));
    main = path.join(workspace, 'main');
    children = [];
    sent = [];
    jobLines = [];
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '0');
  });
  afterEach(async () => {
    await service?.stop(0);
    service = undefined;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill('SIGKILL');
        await exited;
      }
    }
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 30_000);

  function linked(): string {
    makeRepo(main);
    const target = path.join(workspace, 'linked');
    git(main, 'worktree', 'add', '-q', '-b', 'linked', target);
    return fs.realpathSync(target);
  }
  function startService(seedWaitMs = 100): BuilderService {
    service = new BuilderService({ runJob: inProcessJobRunner().runJob,
      send: (message) => sent.push(message),
      jobLog: (line) => jobLines.push(line),
      log: () => {},
      watchOptions: () => ({ debounceMs: 100 }),
      timing: { pollMs: 25, ownRetryMs: 50, recoverWaitMs: 1_000, seedWaitMs },
      housekeeping: false,
    });
    return service;
  }

  it('seeds a linked worktree, records its nonce and common directory, and then answers indexed', async () => {
    const seed = seedNow();
    const target = linked();
    await indexDir(main);
    const result = await seed(target);
    expect(result).toMatchObject({ kind: 'seeded', root: target, source: fs.realpathSync(main) });
    expect(['clone', 'copy', 'backup']).toContain(result.method);
    expect(isInitialized(target)).toBe(true);
    const record = getRegisteredProject(target);
    expect((record?.flags ?? 0) & PROJECT_FLAG_SEEDED).toBe(PROJECT_FLAG_SEEDED);
    expect(record?.commonDir).toBe(await gitCommonDirAsync(target));
    expect(readSeedNonce(target)).toMatch(/^[0-9a-f]{32}$/);
    expect(record?.seedNonce).toBe(readSeedNonce(target));
    expect(await seed(target)).toEqual({ kind: 'indexed', root: target });
  });

  it('returns no-source without creating an index when no sibling is indexed', async () => {
    const seed = seedNow();
    const target = linked();
    expect(await seed(target)).toEqual({ kind: 'no-source', root: target });
    expect(fs.existsSync(path.join(target, '.codegraph'))).toBe(false);
  });

  it('returns not-git without creating an index in a plain directory', async () => {
    const seed = seedNow();
    const plain = path.join(workspace, 'plain');
    fs.mkdirSync(plain);
    expect(await seed(plain)).toEqual({ kind: 'not-git', root: plain });
    expect(fs.existsSync(path.join(plain, '.codegraph'))).toBe(false);
  });

  it('answers indexed for an indexed non-git directory', async () => {
    const seed = seedNow();
    const plain = path.join(workspace, 'plain');
    fs.mkdirSync(plain);
    await indexDir(plain);
    expect(await seed(plain)).toEqual({ kind: 'indexed', root: plain });
  });

  it('disables only automatic seeding and still allows an explicit seed', async () => {
    const seed = seedNow();
    const target = linked();
    await indexDir(main);
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '1');
    expect(await seed(target, { automatic: true })).toEqual({ kind: 'disabled', root: target });
    expect(fs.existsSync(path.join(target, '.codegraph'))).toBe(false);
    expect(await seed(target)).toMatchObject({ kind: 'seeded', root: target, source: fs.realpathSync(main) });
    expect(isInitialized(target)).toBe(true);
  });

  it('never mistakes a non-CodeGraph SQLite database for an index', async () => {
    const seed = seedNow();
    const target = linked();
    await indexDir(main);
    fs.mkdirSync(path.join(target, '.codegraph'));
    const db = new DatabaseSync(path.join(target, '.codegraph', 'codegraph.db'));
    try { db.exec('CREATE TABLE unrelated (value TEXT)'); } finally { db.close(); }
    expect(isInitialized(target)).toBe(false);
    const result = await seed(target);
    expect(result.kind).not.toBe('indexed');
    expect(result.kind).toBe('failed');
  });

  it('answers queued without copying while another process holds rebuild.pid', async () => {
    const seed = seedNow();
    const target = linked();
    await indexDir(main);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
    children.push(child);
    expect(child.pid).toBeDefined();
    const dir = path.join(target, '.codegraph');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'rebuild.pid'), JSON.stringify({ pid: child.pid, mode: 'rebuild', startedAt: Date.now() }));
    expect(await seed(target)).toEqual({ kind: 'queued', root: target });
    expect(fs.readdirSync(dir)).toEqual(['rebuild.pid']);
  });

  it('shares concurrent same-wait seeding calls and installs one copy', async () => {
    const seed = seedNow();
    const target = linked();
    await indexDir(main);
    const logs: string[] = [];
    const opts = { wait: true, log: (line: string) => logs.push(line) };
    const results = await Promise.all([seed(target, opts), seed(target, opts)]);
    expect(results.map((result) => result.kind).every((kind) => kind === 'seeded' || kind === 'indexed')).toBe(true);
    expect(results.some((result) => result.kind === 'seeded')).toBe(true);
    expect(logs).toHaveLength(1);
    expect(isInitialized(target)).toBe(true);
    expect(getRegisteredProject(target)?.seedNonce).toBe(readSeedNonce(target));
  });

  it('routes seedWorktree through the builder queue and replies seeded', async () => {
    const target = linked();
    await indexDir(main);
    const svc = startService();
    await svc.handle({ id: 42, op: 'seedWorktree', root: target, wait: true } as unknown as BuilderRequest);
    expect(sent).toContainEqual(expect.objectContaining({ id: 42, ok: true, result: expect.objectContaining({ kind: 'seeded', root: target, source: fs.realpathSync(main) }) }));
    expect(jobLines.some((line) => / job end seed .* ok$/.test(line))).toBe(true);
    expect(isInitialized(target)).toBe(true);
  });

  it('replies queued for a bounded builder seed behind a blocking job', async () => {
    const target = linked();
    await indexDir(main);
    const svc = startService(30);
    const gate = deferred();
    const started = deferred();
    const blocker = svc.queue.enqueue('cold-build', target, async () => { started.resolve(); await gate.promise; });
    await started.promise;
    try {
      await svc.handle({ id: 43, op: 'seedWorktree', root: target, wait: false } as unknown as BuilderRequest);
      expect(sent).toContainEqual(expect.objectContaining({ id: 43, ok: true, result: { kind: 'queued', root: target } }));
      expect(isInitialized(target)).toBe(false);
    } finally {
      gate.resolve();
      await blocker;
      await svc.queue.whenIdle();
    }
  });

  it('runSeed wait true waits past seedWaitMs for the job result', async () => {
    const host = new BuilderSeedHost(new JobQueue(), { seedWaitMs: 25 });
    const run = host.runSeed.bind(host) as <T>(root: string, source: string, copy: () => Promise<T>, opts?: { wait?: boolean }) => Promise<{ done: boolean; value?: T }>;
    const gate = deferred<string>();
    const started = deferred();
    const pending = run(workspace, main, async () => { started.resolve(); return gate.promise; }, { wait: true });
    await started.promise;
    let settled = false;
    void pending.then(() => { settled = true; });
    try {
      await delay(100);
      expect(settled).toBe(false);
    } finally {
      gate.resolve('copied');
    }
    expect(await pending).toEqual({ done: true, value: 'copied' });
  });

  it('runSeed without options returns done false at its bounded wait behind a job', async () => {
    const queue = new JobQueue();
    const host = new BuilderSeedHost(queue, { seedWaitMs: 25 });
    const gate = deferred();
    const started = deferred();
    const blocker = queue.enqueue('cold-build', workspace, async () => { started.resolve(); await gate.promise; });
    await started.promise;
    let copied = false;
    try {
      expect(await host.runSeed(workspace, main, async () => { copied = true; })).toEqual({ done: false });
      expect(copied).toBe(false);
    } finally {
      gate.resolve();
      await blocker;
      await queue.whenIdle();
    }
    expect(copied).toBe(true);
  });

  it('buildingRootFor names a root until both in-flight seed jobs end', async () => {
    const queue = new JobQueue();
    const host = new BuilderSeedHost(queue, { seedWaitMs: 2_000 });
    const firstGate = deferred();
    const secondGate = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const first = host.runSeed(workspace, main, async () => { firstStarted.resolve(); await firstGate.promise; });
    const second = host.runSeed(workspace, main, async () => { secondStarted.resolve(); await secondGate.promise; });
    await firstStarted.promise;
    expect(host.buildingRootFor(workspace)).toBe(workspace);
    firstGate.resolve();
    await first;
    await secondStarted.promise;
    try {
      expect(host.buildingRootFor(workspace)).toBe(workspace);
    } finally {
      secondGate.resolve();
      await second;
    }
    expect(host.buildingRootFor(workspace)).toBeNull();
  });
});
