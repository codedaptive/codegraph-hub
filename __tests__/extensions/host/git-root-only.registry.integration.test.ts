import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { runProjectPin } from '../../../src/extensions/host/worktree-lifecycle/cli';
import { listRegisteredProjects } from '../../../src/extensions/host/worktree-lifecycle/project-registry';

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

  it.each([false, true])('refuses to pin a non-git directory (indexed=%s)', async (indexed) => {
    if (indexed) CodeGraph.initSync(root).close();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await expect(runProjectPin(root)).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(error.mock.calls.map(([line]) => String(line)).join('\n')).toContain('is not in a git repository');
    expect(listRegisteredProjects()).toEqual([]);
  });
});
