import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { runProjectList, runProjectPin } from '../../../src/extensions/host/worktree-lifecycle/cli';
import { getRegisteredProject, listRegisteredProjects, pinProject, registerProject } from '../../../src/extensions/host/worktree-lifecycle/project-registry';

describe('git-only pins and legacy non-git registrations', () => {
  let workspace: string;
  let root: string;
  let state: string;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'cg-git-only-')));
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
    const text = error.mock.calls.map(([line]) => String(line)).join('\n');
    expect(text).toContain('codegraph init');
    expect(text).toContain('--no-git');
  });

  it('names the no-git flag in the text project listing', () => {
    registerProject(root, { noGit: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runProjectList({});
    const line = log.mock.calls.map(([value]) => String(value)).find((value) => value.includes(root)) ?? '';
    expect(line).toContain('no-git');
  });

  it('names both flags for a pinned opted-in project in the text listing', () => {
    registerProject(root, { noGit: true });
    pinProject(root);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runProjectList({});
    const line = log.mock.calls.map(([value]) => String(value)).find((value) => value.includes(root)) ?? '';
    expect(line).toContain('pinned');
    expect(line).toContain('no-git');
  });

  it('keeps the numeric no-git flag in the JSON listing', () => {
    registerProject(root, { noGit: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runProjectList({ json: true });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual([expect.objectContaining({ root, flags: 4 })]);
  });

  it.each([false, true])('pins an opted-in folder (indexed=%s)', async (indexed) => {
    if (indexed) CodeGraph.initSync(root).close();
    registerProject(root, { noGit: true });
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '1');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await runProjectPin(root);
    expect(exit).not.toHaveBeenCalled();
    expect(getRegisteredProject(root)).toMatchObject({ flags: 5 });
  });
});
