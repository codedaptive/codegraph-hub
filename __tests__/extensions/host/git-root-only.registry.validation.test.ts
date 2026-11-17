// These run the built CLI (dist/bin/codegraph.js), so they are validation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { getRegisteredProject, pinProject } from '../../../src/extensions/host/worktree-lifecycle/project-registry';
import { runCli } from './uninit-unlock.harness';

describe('git-only pins and legacy non-git registrations', () => {
  let workspace: string;
  let root: string;
  let state: string;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cg-git-only-')));
    state = path.join(workspace, 'state');
    root = path.join(workspace, 'plain');
    fs.mkdirSync(root);
    vi.stubEnv('CODEGRAPH_STATE_DIR', state);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('uninit removes the index from a registered non-git directory', async () => {
    CodeGraph.initSync(root).close();
    pinProject(root);
    const result = await runCli(['uninit', '--force', root], state, workspace);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
  }, 300_000);

  it('project remove unregisters a legacy non-git root', async () => {
    CodeGraph.initSync(root).close();
    pinProject(root);
    expect(getRegisteredProject(root)).not.toBeNull();
    const result = await runCli(['project', 'remove', root], state, workspace);
    expect(result.status, result.stderr).toBe(0);
    expect(getRegisteredProject(root)).toBeNull();
    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(true);
  }, 300_000);
});
