import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { pinProject, registerProject } from '../../../src/extensions/host/worktree-lifecycle/project-registry';

const modulePath = '../../../src/extensions/host/server/optedInRootByStat';
const optIn = { noGit: true, seeded: false };

describe('optedInRootByStat', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'cg-opted-walk-')));
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('returns the nearest opted-in ancestor', async () => {
    const { optedInRootByStat } = await import(modulePath);
    const outer = path.join(workspace, 'outer');
    const inner = path.join(outer, 'inner');
    const child = path.join(inner, 'child');
    fs.mkdirSync(child, { recursive: true });
    registerProject(outer, optIn);
    registerProject(inner, optIn);
    expect(optedInRootByStat(child)).toBe(inner);
    expect(optedInRootByStat(outer)).toBe(outer);
  });

  it('ignores pinned and seeded records and unregistered indexes', async () => {
    const { optedInRootByStat } = await import(modulePath);
    const outer = path.join(workspace, 'outer');
    const pinned = path.join(outer, 'pinned');
    const seeded = path.join(pinned, 'seeded');
    const child = path.join(seeded, 'child');
    fs.mkdirSync(path.join(child, '.codegraph'), { recursive: true });
    pinProject(pinned);
    registerProject(seeded, { seeded: true });
    expect(optedInRootByStat(child)).toBeNull();
    registerProject(outer, optIn);
    expect(optedInRootByStat(child)).toBe(outer);
  });
});
