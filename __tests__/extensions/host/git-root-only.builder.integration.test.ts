import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { BuilderService } from '../../../src/extensions/host/builder/service';
import { admitColdBuild, ensureWorktreeIndex, type SeedHost } from '../../../src/extensions/host/worktree-lifecycle/seed';
import type { BuilderToServer } from '../../../src/extensions/host/builder/protocol';

describe('git-only builder admission', () => {
  let workspace: string;
  let service: BuilderService;
  let messages: BuilderToServer[];
  let jobs: string[];

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync('/tmp/cg-git-only-'));
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    messages = [];
    jobs = [];
    service = new BuilderService({
      send: (message) => messages.push(message),
      jobLog: (line) => jobs.push(line),
      log: () => {},
      watchOptions: () => ({}),
      housekeeping: false,
    });
  });

  afterEach(async () => {
    await service.stop(0);
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('refuses cold-build admission for a plain directory and for a non-root inside a worktree', () => {
    const plain = path.join(workspace, 'plain');
    const repo = path.join(workspace, 'repo');
    const sub = path.join(repo, 'sub');
    fs.mkdirSync(plain);
    fs.mkdirSync(sub, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });

    for (const root of [plain, sub]) {
      expect(admitColdBuild(root)).toMatchObject({ ok: false, reason: expect.stringContaining('is not a git worktree root') });
    }
  });

  it('admits cold builds at a git worktree root', () => {
    const repo = path.join(workspace, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    expect(admitColdBuild(repo)).toEqual({ ok: true, approval: { realRoot: repo } });
  });

  it.each([false, true])('does not seed or cold-build a plain directory (index above: %s)', async (indexedAbove) => {
    const parent = path.join(workspace, 'parent');
    const child = path.join(parent, 'child');
    fs.mkdirSync(child, { recursive: true });
    if (indexedAbove) CodeGraph.initSync(parent).close();
    const host: SeedHost = {
      buildingRootFor: () => null,
      hasFailedBuild: () => false,
      queueColdBuild: vi.fn(),
      runSeed: vi.fn(async () => ({ done: false as const })),
    };

    expect(await ensureWorktreeIndex(child, host)).toEqual({ kind: 'none' });
    expect(host.queueColdBuild).not.toHaveBeenCalled();
    expect(host.runSeed).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(child, '.codegraph'))).toBe(false);
  });

  it('does not hold a non-git ancestor index for a plain directory', async () => {
    const parent = path.join(workspace, 'parent');
    const child = path.join(parent, 'child');
    fs.mkdirSync(child, { recursive: true });
    CodeGraph.initSync(parent).close();

    expect(await service.ensure(child)).toEqual({ kind: 'none' });
    expect(service.holders.roots()).toEqual([]);
    expect(service.freshness(parent)).toBeNull();
    expect(jobs).toEqual([]);
    expect(fs.existsSync(path.join(child, '.codegraph'))).toBe(false);
  });

  it('does not hold or catch up a plain directory with its own index', async () => {
    const root = path.join(workspace, 'plain');
    fs.mkdirSync(root);
    CodeGraph.initSync(root).close();

    expect(await service.ensure(root)).toEqual({ kind: 'none' });
    await service.queue.whenIdle();
    expect(service.holders.roots()).toEqual([]);
    expect(service.freshness(root)).toBeNull();
    expect(jobs).toEqual([]);
  });

  it('ignores an extra anchorRoot field on an ensure request', async () => {
    const root = path.join(workspace, 'plain');
    const child = path.join(root, 'sub');
    fs.mkdirSync(child, { recursive: true });
    const request = { id: 1, op: 'ensure' as const, projectPath: child, anchorRoot: root };

    await service.handle(request);
    expect(messages).toContainEqual({ id: 1, ok: true, result: { kind: 'none' } });
    expect(service.holders.roots()).toEqual([]);
    expect(jobs).toEqual([]);
    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
  });

  it.each([undefined, 'index'] as const)('refuses a non-git index fence of kind %s before writing a lock', async (kind) => {
    const root = path.join(workspace, 'plain');
    fs.mkdirSync(root);
    await service.handle({ id: 2, op: 'fence', root, ...(kind ? { kind } : {}) });

    expect(messages).toContainEqual(expect.objectContaining({ id: 2, ok: false }));
    expect(fs.existsSync(path.join(root, '.codegraph', 'rebuild.pid'))).toBe(false);
    expect(jobs).toEqual([]);
  });

  it('still accepts a release fence outside git', async () => {
    const root = path.join(workspace, 'plain');
    fs.mkdirSync(root);
    await service.handle({ id: 3, op: 'fence', root, kind: 'release' });
    expect(messages).toContainEqual(expect.objectContaining({ id: 3, ok: true }));
    await service.handle({ id: 4, op: 'unfence', root });
  });

  it.each(['init', 'reindex', 'rebuild', 'reindex-leased'] as const)('rejects non-git cliIndex mode %s without queuing', async (mode) => {
    const root = path.join(workspace, 'plain');
    fs.mkdirSync(root);
    await service.handle({ id: 5, op: 'cliIndex', root, mode });

    expect(messages).toContainEqual(expect.objectContaining({ id: 5, ok: false, error: expect.stringContaining('is not in a git repository') }));
    expect(jobs).toEqual([]);
    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
  });

  it('rejects non-git cliSync without queuing or creating an index', async () => {
    const root = path.join(workspace, 'plain');
    fs.mkdirSync(root);
    await service.handle({ id: 6, op: 'cliSync', root });

    expect(messages).toContainEqual(expect.objectContaining({ id: 6, ok: false, error: expect.stringContaining('is not in a git repository') }));
    expect(jobs).toEqual([]);
    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
  });
});
