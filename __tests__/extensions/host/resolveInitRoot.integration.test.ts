import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getRegisteredProject, listRegisteredProjects, registerProject } from '../../../src/extensions/host/worktree-lifecycle/project-registry';
import { requireGitWorktreeRoot } from '../../../src/extensions/host/worktree-lifecycle/requireGitWorktreeRoot';

const modulePath = '../../../src/extensions/host/worktree-lifecycle/resolveInitRoot';

describe('resolveInitRoot', () => {
  let workspace: string;
  let home: string;
  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'cg-init-root-')));
    home = path.join(workspace, 'home');
    fs.mkdirSync(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it.each([false, true])('uses a git root without registering it (noGit=%s)', async (noGit) => {
    const { resolveInitRoot } = await import(modulePath);
    const repo = path.join(workspace, 'repo');
    const child = path.join(repo, 'sub');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(child);
    expect(resolveInitRoot(child, { noGit, force: false })).toEqual({ root: repo, optedIn: false });
    expect(listRegisteredProjects()).toEqual([]);
  });

  it('uses an existing opted-in ancestor without opting in again', async () => {
    const { resolveInitRoot } = await import(modulePath);
    const root = path.join(workspace, 'plain');
    const child = path.join(root, 'sub');
    fs.mkdirSync(child, { recursive: true });
    const optIn = { noGit: true, seeded: false };
    registerProject(root, optIn);
    const before = getRegisteredProject(root);
    expect(resolveInitRoot(child, { noGit: true, force: false })).toEqual({ root, optedIn: false });
    expect(getRegisteredProject(root)).toEqual(before);
    expect(getRegisteredProject(child)).toBeNull();
  });

  it.each([false, true])('refuses non-git without opt-in and writes no record (force=%s)', async (force) => {
    const { resolveInitRoot } = await import(modulePath);
    const root = path.join(workspace, 'plain');
    fs.mkdirSync(root);
    const result = resolveInitRoot(root, { noGit: false, force });
    expect(result.refusal.startsWith(`${root} is not in a git repository`)).toBe(true);
    expect(result.refusal).toContain('codegraph init');
    expect(result.refusal).toContain('--no-git');
    expect(getRegisteredProject(root)).toBeNull();
  });

  it('opts in a safe directory under its canonical real spelling', async () => {
    const { resolveInitRoot } = await import(modulePath);
    const root = path.join(workspace, 'plain');
    const alias = path.join(workspace, 'alias');
    fs.mkdirSync(root);
    fs.symlinkSync(root, alias);
    expect(resolveInitRoot(alias, { noGit: true, force: false })).toEqual({ root, optedIn: true });
    expect((getRegisteredProject(root)?.flags ?? 0) & 4).toBe(4);
    expect(requireGitWorktreeRoot(alias)).toEqual({ root });
  });

  it('refuses the home directory without force and writes no record', async () => {
    const { resolveInitRoot } = await import(modulePath);
    expect(resolveInitRoot(home, { noGit: true, force: false })).toEqual({ refusal: expect.stringContaining('Refusing to initialize') });
    expect(getRegisteredProject(home)).toBeNull();
  });

  it('allows the home directory when force is explicit', async () => {
    const { resolveInitRoot } = await import(modulePath);
    expect(resolveInitRoot(home, { noGit: true, force: true })).toEqual({ root: home, optedIn: true });
    expect((getRegisteredProject(home)?.flags ?? 0) & 4).toBe(4);
  });

  it.each(['missing', 'file'])('refuses a %s path and writes no record', async (kind) => {
    const { resolveInitRoot } = await import(modulePath);
    const target = path.join(workspace, kind);
    if (kind === 'file') fs.writeFileSync(target, 'not a directory');
    expect(resolveInitRoot(target, { noGit: true, force: false })).toEqual({ refusal: expect.stringContaining('is not a directory') });
    expect(getRegisteredProject(target)).toBeNull();
  });
});
