import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { MCPEngine } from '../../../src/mcp/engine';
import { __setLoadCodeGraphForTests } from '../../../src/mcp/tools';
import type { BuilderClient } from '../../../src/extensions/host/builder/client';
import { BuilderSeedHost } from '../../../src/extensions/host/builder/seed-host';
import { JobQueue } from '../../../src/extensions/host/builder/queue';
import { buildingNote, ensureWorktreeIndex, unseededWorktreeNote } from '../../../src/extensions/host/worktree-lifecycle/seed';
import { listGitWorktrees } from '../../../src/extensions/host/worktree-lifecycle/git';
import { ADMIT_ALL } from '../../helpers/admit-all';

const gitFailure = vi.hoisted(() => ({ timeout: false }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      if (gitFailure.timeout && args[0] === 'git') {
        const callback = args[args.length - 1];
        if (typeof callback === 'function') {
          callback(Object.assign(new Error('git timed out'), { killed: true, signal: 'SIGTERM', code: null }), '', '');
        }
        return undefined;
      }
      return Reflect.apply(actual.execFile, undefined, args);
    },
  };
});

describe('pending index preparation', () => {
  let workspace: string;
  let indexedWorkspace: string | undefined;
  let engine: MCPEngine | undefined;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pending-note-')));
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '');
    __setLoadCodeGraphForTests(CodeGraph);
  });

  afterEach(async () => {
    gitFailure.timeout = false;
    await engine?.stop();
    engine = undefined;
    __setLoadCodeGraphForTests(null);
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
    if (indexedWorkspace) fs.rmSync(indexedWorkspace, { recursive: true, force: true });
    indexedWorkspace = undefined;
  });

  it('answers the building note on successive calls when the builder says pending', async () => {
    const main = path.join(workspace, 'main');
    const worktree = path.join(workspace, 'worktree');
    fs.mkdirSync(main);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: main, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('commit', '-q', '--allow-empty', '-m', 'initial');
    git('worktree', 'add', '-q', '-b', 'worktree', worktree);
    const calls: string[] = [];
    const builder = {
      ensure: async (p: string) => { calls.push(p); return { kind: 'none', pending: true }; },
      caughtUp: async () => undefined,
      freshness: () => null,
    };
    engine = new MCPEngine({ builder: builder as unknown as BuilderClient });
    for (let call = 0; call < 2; call++) {
      const result = await engine.getToolHandler().execute('codegraph_explore', { query: 'x', projectPath: worktree }, undefined, ADMIT_ALL);
      const text = result.content.map((item) => item.type === 'text' ? item.text ?? '' : '').join('\n');
      expect.soft(result.isError).toBeFalsy();
      expect.soft(text).toContain(buildingNote(worktree));
      expect.soft(text).not.toContain(unseededWorktreeNote(worktree, worktree));
      expect.soft(text).not.toContain('the build failed');
    }
    expect(calls).toEqual([worktree, worktree]);
  });

  it('serves an existing index when the builder says pending', async () => {
    indexedWorkspace = fs.realpathSync(fs.mkdtempSync('/tmp/cg-pending-indexed-'));
    fs.writeFileSync(path.join(indexedWorkspace, 'fixture.ts'), 'export function pendingIndexSymbol() { return 42; }\n');
    const index = await CodeGraph.init(indexedWorkspace);
    try {
      expect((await index.indexAll()).success).toBe(true);
    } finally {
      index.close();
    }

    const builder = {
      ensure: async () => ({ kind: 'none', pending: true }),
      caughtUp: async () => undefined,
      freshness: () => null,
      // The engine releases the root it opened when it shuts down.
      release: async () => undefined,
    };
    engine = new MCPEngine({ builder: builder as unknown as BuilderClient });
    const result = await engine.getToolHandler().execute('codegraph_search', {
      query: 'pendingIndexSymbol', projectPath: indexedWorkspace,
    }, undefined, ADMIT_ALL);
    const text = result.content.map((item) => item.type === 'text' ? item.text ?? '' : '').join('\n');
    expect.soft(text).toContain('pendingIndexSymbol');
    expect.soft(text).not.toContain(buildingNote(indexedWorkspace));
    expect.soft(result.isError).toBeFalsy();
  });

  it('returns pending when the git worktree lookup times out', async () => {
    const root = path.join(workspace, 'repo');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    gitFailure.timeout = true;
    const host = new BuilderSeedHost(new JobQueue(), { seedWaitMs: 0 });
    expect(await ensureWorktreeIndex(root, host)).toEqual({ kind: 'none', pending: true });
  });

  it('keeps non-timeout git failures as none and a null worktree list', async () => {
    const plain = path.join(workspace, 'plain');
    fs.mkdirSync(plain);
    expect(await listGitWorktrees(plain)).toBeNull();
    const invalidRepo = path.join(workspace, 'invalid');
    fs.mkdirSync(path.join(invalidRepo, '.git'), { recursive: true });
    const host = new BuilderSeedHost(new JobQueue(), { seedWaitMs: 0 });
    expect(await ensureWorktreeIndex(invalidRepo, host)).toEqual({ kind: 'none' });
  });
});
