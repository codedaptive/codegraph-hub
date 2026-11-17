import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import CodeGraph from '../../../src/index';
import { isInitialized } from '../../../src/directory';
import * as projectCli from '../../../src/extensions/host/worktree-lifecycle/cli';
import hostExtension from '../../../src/extensions/host/extension';
import { CliRelay, type CliRelayEngine } from '../../../src/extensions/host/builder/cli-relay';
import type { JsonRpcTransport } from '../../../src/mcp/transport';
import {
  getRegisteredProject,
  PROJECT_FLAG_PINNED,
  PROJECT_FLAG_SEEDED,
  readSeedNonce,
  pinProject,
} from '../../../src/extensions/host/worktree-lifecycle/project-registry';

type Route = { seed: (root: string) => Promise<unknown>; close: () => void };
type SeedCommand = (pathArg: string, deps: { route: () => Promise<Route | null> }) => Promise<number>;

function seedCommand(): SeedCommand {
  // Access the future export without making the whole suite fail to load before it exists.
  const command = (projectCli as unknown as { projectSeedExitCode?: SeedCommand }).projectSeedExitCode;
  expect(typeof command, 'projectSeedExitCode is exported').toBe('function');
  return command!;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function makeRepo(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'a.ts'), 'export function alpha() { return 1; }\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
}

async function index(root: string): Promise<void> {
  const cg = await CodeGraph.init(root);
  try { await cg.indexAll(); } finally { cg.close(); }
}

function addWorktree(repo: string, target: string): void {
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', target, 'HEAD');
}

function expectSeedRecord(root: string): void {
  const record = getRegisteredProject(root);
  expect(record, 'seeded root is registered').not.toBeNull();
  expect(record!.flags & PROJECT_FLAG_SEEDED).toBe(PROJECT_FLAG_SEEDED);
  expect(record!.seedNonce).toMatch(/^[0-9a-f]{32}$/);
  expect(record!.seedNonce).toBe(readSeedNonce(root));
}

describe('project seed CLI and builder relay', () => {
  let workspace: string;
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  const noRoute = async () => null;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cg-pinned-seed-cli-')));
    // A fresh state dir prevents the pin command from reaching a machine server.
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '0');
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  // The command emits one result line; error outcomes use stderr per the CLI contract.
  function expectLine(stream: 'stdout' | 'stderr', text: RegExp): void {
    const chosen = stream === 'stdout' ? log : error;
    const other = stream === 'stdout' ? error : log;
    expect(chosen).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(chosen.mock.calls[0]).toHaveLength(1);
    expect(String(chosen.mock.calls[0][0])).toMatch(text);
    expect(String(chosen.mock.calls[0][0])).not.toMatch(/[\r\n]/);
  }

  // Building a real index and invoking git may take over five seconds on the loaded machine.
  it('returns 0 for an already indexed worktree without copying it', async () => {
    const command = seedCommand();
    const main = path.join(workspace, 'main');
    makeRepo(main);
    await index(main);
    const db = path.join(main, '.codegraph', 'codegraph.db');
    const before = fs.readFileSync(db);
    log.mockClear(); error.mockClear();
    expect(await command(main, { route: noRoute })).toBe(0);
    expect(fs.readFileSync(db)).toEqual(before);
    expect(getRegisteredProject(main)?.flags ?? 0).toBe(0);
    expectLine('stdout', /already has an index/i);
  }, 30_000);

  // Building a real index and cloning it into a git worktree may exceed five seconds under load.
  it('returns 0 and registers the nonce when it seeds from an indexed sibling', async () => {
    const command = seedCommand();
    const main = path.join(workspace, 'main'); const target = path.join(workspace, 'target');
    makeRepo(main); addWorktree(main, target); await index(main);
    log.mockClear(); error.mockClear();
    expect(await command(target, { route: noRoute })).toBe(0);
    expect(isInitialized(target)).toBe(true);
    expectSeedRecord(target);
    expectLine('stdout', /seeded .* from /i);
  }, 30_000);

  it('returns 3 without creating an index when no sibling has one', async () => {
    const command = seedCommand();
    const main = path.join(workspace, 'main'); const target = path.join(workspace, 'target');
    makeRepo(main); addWorktree(main, target);
    expect(await command(target, { route: noRoute })).toBe(3);
    expect(fs.existsSync(path.join(target, '.codegraph'))).toBe(false);
    expectLine('stdout', /sibling.*index/i);
  });

  it('returns 3 without creating an index outside git', async () => {
    const command = seedCommand();
    const target = path.join(workspace, 'plain'); fs.mkdirSync(target);
    expect(await command(target, { route: noRoute })).toBe(3);
    expect(fs.existsSync(path.join(target, '.codegraph'))).toBe(false);
    expectLine('stdout', /not.*git/i);
  });

  it('returns 1 for a missing directory', async () => {
    const command = seedCommand();
    expect(await command(path.join(workspace, 'missing'), { route: noRoute })).toBe(1);
    expectLine('stderr', /no such directory/i);
  });

  it('returns 1 and closes the route when the routed seed rejects', async () => {
    const command = seedCommand();
    const close = vi.fn();
    const route = { seed: vi.fn().mockRejectedValue(new Error('seed broke')), close };
    expect(await command(workspace, { route: async () => route })).toBe(1);
    expect(close).toHaveBeenCalledOnce();
    expectLine('stderr', /could not seed.*seed broke/i);
  });

  it('returns 1 for a routed failed outcome', async () => {
    const command = seedCommand();
    const close = vi.fn();
    const route = { seed: vi.fn().mockResolvedValue({ routed: true, result: { kind: 'failed', root: workspace, reason: 'copy failed' } }), close };
    expect(await command(workspace, { route: async () => route })).toBe(1);
    expect(close).toHaveBeenCalledOnce();
    expectLine('stderr', /could not seed.*copy failed/i);
  });

  it('uses and closes the route with an absolute root without copying locally', async () => {
    const command = seedCommand();
    const target = path.join(workspace, 'target'); fs.mkdirSync(target);
    const close = vi.fn();
    const seed = vi.fn().mockResolvedValue({ routed: true, result: { kind: 'seeded', root: target, source: '/sibling', method: 'copy' } });
    const relative = path.relative(process.cwd(), target);
    expect(await command(relative, { route: async () => ({ seed, close }) })).toBe(0);
    expect(seed).toHaveBeenCalledExactlyOnceWith(target);
    expect(close).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(target, '.codegraph'))).toBe(false);
    expectLine('stdout', /seeded .* from /i);
  });

  // Building a real sibling index and seeding it can exceed five seconds under load.
  it('falls back to in-process seeding when the route does not route', async () => {
    const command = seedCommand();
    const main = path.join(workspace, 'main'); const target = path.join(workspace, 'target');
    makeRepo(main); addWorktree(main, target); await index(main);
    const close = vi.fn();
    const seed = vi.fn().mockResolvedValue({ routed: false, reason: 'builder down' });
    log.mockClear(); error.mockClear();
    expect(await command(target, { route: async () => ({ seed, close }) })).toBe(0);
    expect(seed).toHaveBeenCalledExactlyOnceWith(target);
    expect(close).toHaveBeenCalledOnce();
    expect(isInitialized(target)).toBe(true);
    expectSeedRecord(target);
    expectLine('stdout', /seeded .* from /i);
  }, 30_000);

  // A real git worktree and index are created and copied, which can exceed five seconds under load.
  it('seeds a linked worktree before pinning its own root', async () => {
    const main = path.join(workspace, 'main'); const target = path.join(workspace, 'target');
    makeRepo(main); addWorktree(main, target); await index(main);
    await projectCli.runProjectPin(target);
    expect(isInitialized(target), 'pin seeds the worktree').toBe(true);
    expectSeedRecord(target);
    expect(getRegisteredProject(target)!.flags & PROJECT_FLAG_PINNED).toBe(PROJECT_FLAG_PINNED);
  }, 30_000);

  // Initializing a real index and running git can exceed five seconds under load.
  it('pins an indexed subdirectory without seeding, then unpins and removes it', async () => {
    const root = path.join(workspace, 'repo');
    makeRepo(root);
    const sub = path.join(root, 'packages', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const cg = await CodeGraph.init(sub, { index: false });
    cg.close();
    expect(isInitialized(root)).toBe(false);
    expect(isInitialized(sub)).toBe(true);
    const stub = answering({ kind: 'no-source', root });
    await pinWith(sub, { route: stub.route });
    expect(getRegisteredProject(sub)?.flags ?? 0).toBe(PROJECT_FLAG_PINNED);
    expect(getRegisteredProject(root)).toBeNull();
    expect(stub.route).not.toHaveBeenCalled();
    projectCli.runProjectUnpin(sub);
    expect(getRegisteredProject(sub)).not.toBeNull();
    expect(getRegisteredProject(sub)!.flags & PROJECT_FLAG_PINNED).toBe(0);
    projectCli.runProjectRemove(sub);
    expect(getRegisteredProject(sub)).toBeNull();
  }, 30_000);

  // Initializing a real index and running git can exceed five seconds under load.
  it('unpin and remove prefer an indexed subdirectory to its registered worktree', async () => {
    const root = path.join(workspace, 'repo');
    makeRepo(root);
    const sub = path.join(root, 'packages', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const cg = await CodeGraph.init(sub, { index: false });
    cg.close();
    pinProject(root); pinProject(sub);
    const rootBefore = getRegisteredProject(root);
    projectCli.runProjectUnpin(sub);
    expect(getRegisteredProject(sub)!.flags & PROJECT_FLAG_PINNED).toBe(0);
    expect(getRegisteredProject(root)).toEqual(rootBefore);
    projectCli.runProjectRemove(sub);
    expect(getRegisteredProject(sub)).toBeNull();
    expect(getRegisteredProject(root)).toEqual(rootBefore);
  }, 30_000);

  type PinDeps = { route: () => Promise<Route | null> };
  const pinWith = (pathArg: string, deps?: PinDeps): Promise<void> =>
    (projectCli.runProjectPin as unknown as (p: string, d?: PinDeps) => Promise<void>)(pathArg, deps);

  /** A route stub that answers every seed `routed` with `result`. */
  function answering(result: Record<string, unknown>) {
    const seed = vi.fn().mockResolvedValue({ routed: true, result });
    const close = vi.fn();
    const route = vi.fn(async () => ({ seed, close }));
    return { seed, close, route };
  }

  /** A linked worktree outside its main checkout, with neither indexed. */
  function unindexedWorktree(): { main: string; target: string; sub: string } {
    const main = path.join(workspace, 'main'); const target = path.join(workspace, 'target');
    makeRepo(main); addWorktree(main, target);
    const sub = path.join(target, 'packages', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    return { main, target, sub };
  }

  function expectPinned(root: string): void {
    expect((getRegisteredProject(root)?.flags ?? 0) & PROJECT_FLAG_PINNED, `${root} is pinned`).toBe(PROJECT_FLAG_PINNED);
  }

  // Building a real outer index and running git can exceed five seconds under load.
  it('pins the worktree rather than its indexed non-git ancestor', async () => {
    const outer = path.join(workspace, 'outer');
    fs.mkdirSync(outer);
    fs.writeFileSync(path.join(outer, 'outer.ts'), 'export const outer = true;\n');
    await index(outer);
    const main = path.join(outer, 'main'); const target = path.join(outer, 'target');
    makeRepo(main); addWorktree(main, target);
    const stub = answering({ kind: 'no-source', root: target });
    log.mockClear(); error.mockClear();
    await pinWith(target, { route: stub.route });
    expectPinned(target);
    expect(getRegisteredProject(outer)).toBeNull();
    expect(error).not.toHaveBeenCalled();
    expect(log.mock.calls.some(([line]) => String(line).includes(`Pinned ${target}`))).toBe(true);
  }, 30_000);

  // Building a real main index and running git can exceed five seconds under load.
  it('pins an indexed main checkout for a nested linked worktree without a seed', async () => {
    const main = path.join(workspace, 'main');
    makeRepo(main); await index(main);
    const target = path.join(main, '.worktrees', 't');
    addWorktree(main, target);
    const stub = answering({ kind: 'no-source', root: target });
    await pinWith(target, { route: stub.route });
    expectPinned(main);
    expect(getRegisteredProject(target)).toBeNull();
    expect(stub.route).not.toHaveBeenCalled();
  }, 30_000);

  // Building an index and running git can exceed five seconds under load.
  it('unpin and remove resolve an indexed ancestor before a registered worktree', async () => {
    const outer = path.join(workspace, 'outer'); fs.mkdirSync(outer);
    await index(outer);
    const main = path.join(outer, 'main'); const target = path.join(outer, 'target');
    makeRepo(main); addWorktree(main, target);
    pinProject(outer); pinProject(target);
    const targetBefore = getRegisteredProject(target);
    projectCli.runProjectUnpin(target);
    expect(getRegisteredProject(outer)!.flags & PROJECT_FLAG_PINNED).toBe(0);
    expect(getRegisteredProject(target)).toEqual(targetBefore);
    projectCli.runProjectRemove(target);
    expect(getRegisteredProject(outer)).toBeNull();
    expect(getRegisteredProject(target)).toEqual(targetBefore);
  }, 30_000);

  it('pins the given subdirectory and prints no sibling when no worktree has an index', async () => {
    const { target, sub } = unindexedWorktree();
    log.mockClear(); error.mockClear();
    await pinWith(sub, { route: noRoute });
    expectPinned(sub);
    expect(getRegisteredProject(target)).toBeNull();
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[0][0])).toMatch(/no sibling.*index/i);
    expect(String(log.mock.calls[1][0])).toContain(`Pinned ${sub}`);
  });

  it('pins the given subdirectory and prints a routed seed failure', async () => {
    const { target, sub } = unindexedWorktree();
    const stub = answering({ kind: 'failed', root: target, reason: 'copy failed' });
    await pinWith(sub, { route: stub.route });
    expect(stub.seed).toHaveBeenCalledExactlyOnceWith(target);
    expect(stub.close).toHaveBeenCalledOnce();
    expectPinned(sub);
    expect(getRegisteredProject(target)).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toMatch(/copy failed/i);
  });

  it('pins the worktree root and prints a routed queued outcome', async () => {
    const { target, sub } = unindexedWorktree();
    const stub = answering({ kind: 'queued', root: target });
    await pinWith(sub, { route: stub.route });
    expect(stub.seed).toHaveBeenCalledExactlyOnceWith(target);
    expect(stub.close).toHaveBeenCalledOnce();
    expectPinned(target);
    expect(getRegisteredProject(sub)).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toMatch(/queued/i);
  });

  it('pins the given subdirectory without seeding when the kill switch is on', async () => {
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '1');
    const { target, sub } = unindexedWorktree();
    const stub = answering({ kind: 'seeded', root: target, source: '/sibling', method: 'copy' });
    await pinWith(sub, { route: stub.route });
    expectPinned(sub);
    expect(getRegisteredProject(target)).toBeNull();
    expect(stub.route).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  // Indexing a real sibling and copying its index can exceed five seconds under load.
  it('seeds and pins the worktree root when given a subdirectory and an indexed sibling', async () => {
    const { main, target, sub } = unindexedWorktree();
    await index(main);
    log.mockClear(); error.mockClear();
    await pinWith(sub, { route: noRoute });
    expect(isInitialized(target)).toBe(true);
    expectSeedRecord(target);
    expectPinned(target);
    expect(getRegisteredProject(sub)).toBeNull();
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[0][0])).toContain(`Seeded ${target} from ${main}`);
  }, 30_000);

  it('unpins and removes the worktree root reached from an unindexed subdirectory', async () => {
    const { target, sub } = unindexedWorktree();
    pinProject(target);
    projectCli.runProjectUnpin(sub);
    expect(getRegisteredProject(target)).not.toBeNull();
    expect(getRegisteredProject(target)!.flags & PROJECT_FLAG_PINNED).toBe(0);
    projectCli.runProjectRemove(sub);
    expect(getRegisteredProject(target)).toBeNull();
  });

  it('relays seed on an uninitialized root to the builder with wait true', async () => {
    const target = path.join(workspace, 'target'); fs.mkdirSync(target);
    const result = { kind: 'seeded', root: target, source: '/sibling', method: 'copy' };
    const seedWorktree = vi.fn().mockResolvedValue(result);
    const sendResult = vi.fn(); const sendError = vi.fn();
    const transport = { sendResult, sendError, notify: vi.fn() } as unknown as JsonRpcTransport;
    const engine = { getBuilder: () => ({ isUp: () => true, seedWorktree }) } as unknown as CliRelayEngine;
    const relay = new CliRelay(transport, engine);
    await relay.handleIndexWrite({ jsonrpc: '2.0', id: 1, method: 'codegraph/indexWrite', params: { op: 'seed', root: target } });
    expect(sendError).not.toHaveBeenCalled();
    expect(seedWorktree).toHaveBeenCalledExactlyOnceWith(target, { wait: true });
    expect(sendResult).toHaveBeenCalledExactlyOnceWith(1, { routed: true, result });
  });

  it('answers routed false for seed when the builder is not up', async () => {
    const target = path.join(workspace, 'target'); fs.mkdirSync(target);
    const seedWorktree = vi.fn(); const sendResult = vi.fn(); const sendError = vi.fn();
    const transport = { sendResult, sendError, notify: vi.fn() } as unknown as JsonRpcTransport;
    const engine = { getBuilder: () => ({ isUp: () => false, seedWorktree }) } as unknown as CliRelayEngine;
    const relay = new CliRelay(transport, engine);
    await relay.handleIndexWrite({ jsonrpc: '2.0', id: 2, method: 'codegraph/indexWrite', params: { op: 'seed', root: target } });
    expect(sendError).not.toHaveBeenCalled();
    expect(seedWorktree).not.toHaveBeenCalled();
    expect(sendResult).toHaveBeenCalledWith(2, expect.objectContaining({ routed: false }));
  });

  it('registers project seed with its required path and exit codes in the description', () => {
    const program = new Command();
    hostExtension.registerCommands!(program);
    const project = program.commands.find((cmd) => cmd.name() === 'project');
    const seed = project?.commands.find((cmd) => cmd.name() === 'seed');
    expect(seed, 'project seed is registered').toBeDefined();
    expect(seed!.usage()).toContain('<path>');
    expect(seed!.description()).toMatch(/\b0\b/);
    expect(seed!.description()).toMatch(/\b3\b/);
    expect(seed!.description()).toMatch(/\b1\b/);
  });
});
