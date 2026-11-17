import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { choosePinRoot } from '../../../src/extensions/host/worktree-lifecycle/choosePinRoot';
import type { WorktreeSeedOutcome } from '../../../src/extensions/host/worktree-lifecycle/seed';

function initialize(root: string): void {
  const directory = path.join(root, '.codegraph');
  fs.mkdirSync(directory);
  const db = new DatabaseSync(path.join(directory, 'codegraph.db'));
  db.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY)');
  db.close();
}

describe('choosePinRoot', () => {
  let workspace: string;
  let repo: string;
  let indexRoot: string;
  let absolute: string;

  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '0');
    vi.stubEnv('CODEGRAPH_DIR', '.codegraph');
    workspace = fs.realpathSync(fs.mkdtempSync('/tmp/cg-pinroot-'));
    repo = path.join(workspace, 'repo');
    indexRoot = path.join(repo, 'index-root');
    absolute = path.join(repo, 'src', 'nested');
    fs.mkdirSync(indexRoot, { recursive: true });
    fs.mkdirSync(absolute, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('returns the initialized index root inside git without seeding', async () => {
    initialize(indexRoot);
    const seed = vi.fn(async (): Promise<WorktreeSeedOutcome> => ({ kind: 'queued', root: 'ignored' }));

    expect(await choosePinRoot(absolute, repo, indexRoot, seed)).toBe(indexRoot);
    expect(seed).not.toHaveBeenCalled();
  });

  it('returns the resolved index root without seeding when auto-seeding is disabled', async () => {
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '1');
    const seed = vi.fn(async (): Promise<WorktreeSeedOutcome> => ({ kind: 'queued', root: 'ignored' }));

    expect(await choosePinRoot(absolute, repo, indexRoot, seed)).toBe(indexRoot);
    expect(seed).not.toHaveBeenCalled();
  });

  it.each<WorktreeSeedOutcome>([
    { kind: 'seeded', root: 'ignored', source: 'other', method: 'copy' },
    { kind: 'indexed', root: 'ignored' },
    { kind: 'queued', root: 'ignored' },
  ])('seeds the path worktree and returns it for $kind', async (outcome) => {
    const seed = vi.fn(async (): Promise<WorktreeSeedOutcome> => outcome);

    expect(await choosePinRoot(absolute, repo, indexRoot, seed)).toBe(repo);
    expect(seed).toHaveBeenCalledExactlyOnceWith(repo);
  });

  it.each<WorktreeSeedOutcome>([
    { kind: 'no-source', root: 'ignored' },
    { kind: 'failed', root: 'ignored', reason: 'test failure' },
    { kind: 'disabled', root: 'ignored' },
    { kind: 'not-git', root: 'ignored' },
  ])('seeds the path worktree and returns the resolved index root for $kind', async (outcome) => {
    const seed = vi.fn(async (): Promise<WorktreeSeedOutcome> => outcome);

    expect(await choosePinRoot(absolute, repo, indexRoot, seed)).toBe(indexRoot);
    expect(seed).toHaveBeenCalledExactlyOnceWith(repo);
  });

  it('ignores an initialized non-git index above the repo and seeds the worktree', async () => {
    initialize(workspace);
    const seed = vi.fn(async (): Promise<WorktreeSeedOutcome> => ({ kind: 'failed', root: 'ignored', reason: 'test failure' }));

    expect(await choosePinRoot(absolute, repo, workspace, seed)).toBe(repo);
    expect(seed).toHaveBeenCalledExactlyOnceWith(repo);
  });

  it('uses an initialized git root instead of an initialized non-git ancestor without seeding', async () => {
    initialize(workspace);
    initialize(repo);
    const seed = vi.fn(async (): Promise<WorktreeSeedOutcome> => ({ kind: 'queued', root: 'ignored' }));

    expect(await choosePinRoot(absolute, repo, workspace, seed)).toBe(repo);
    expect(seed).not.toHaveBeenCalled();
  });

  it('uses the git root instead of a non-git ancestor when auto-seeding is disabled', async () => {
    initialize(workspace);
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '1');
    const seed = vi.fn(async (): Promise<WorktreeSeedOutcome> => ({ kind: 'queued', root: 'ignored' }));

    expect(await choosePinRoot(absolute, repo, workspace, seed)).toBe(repo);
    expect(seed).not.toHaveBeenCalled();
  });
});
