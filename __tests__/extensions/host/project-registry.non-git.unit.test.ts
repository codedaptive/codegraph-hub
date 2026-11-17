import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as registry from '../../../src/extensions/host/worktree-lifecycle/project-registry';

const optIn = { noGit: true, seeded: false };
const api = registry as typeof registry & { PROJECT_FLAG_NO_GIT: number; clearNonGitOptIn: (root: string) => registry.RegisteredProject | null };

describe('non-git registry opt-in', () => {
  let workspace: string;
  let root: string;
  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'cg-opted-registry-')));
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    root = path.join(workspace, 'project');
    fs.mkdirSync(root);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('assigns the opt-in flag bit 2', () => {
    expect(api.PROJECT_FLAG_NO_GIT).toBe(4);
  });

  it('sets and preserves opt-in alongside pin, seed and nonce on re-registration', () => {
    registry.pinProject(root);
    registry.registerProject(root, { seeded: true, seedNonce: 'abc123' });
    registry.registerProject(root, optIn);
    const noOptIn = { noGit: false, seeded: false };
    registry.registerProject(root, noOptIn);
    expect(registry.getRegisteredProject(root)).toMatchObject({ flags: 7, seedNonce: 'abc123' });
  });

  it('clears opt-in without unpinning or changing the nonce', () => {
    registry.pinProject(root);
    registry.registerProject(root, { seeded: true, seedNonce: 'abc123' });
    registry.registerProject(root, optIn);
    api.clearNonGitOptIn(root);
    expect(registry.getRegisteredProject(root)).toMatchObject({ flags: 3, seedNonce: 'abc123' });
  });

  it('leaves no opt-in record after clearing the only flag', () => {
    registry.registerProject(root, optIn);
    api.clearNonGitOptIn(root);
    expect((registry.getRegisteredProject(root)?.flags ?? 0) & 4).toBe(0);
  });

  it('returns null when clearing an unregistered root', () => {
    expect(api.clearNonGitOptIn(root)).toBeNull();
  });
});
