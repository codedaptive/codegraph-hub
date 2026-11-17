import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BuilderService } from '../../../src/extensions/host/builder/service';
import type { BuilderToServer } from '../../../src/extensions/host/builder/protocol';
import { registerProject } from '../../../src/extensions/host/worktree-lifecycle/project-registry';

describe('builder non-git opt-in', () => {
  let workspace: string;
  let service: BuilderService;
  let messages: BuilderToServer[];
  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'cg-opted-builder-')));
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    messages = [];
    service = new BuilderService({ send: (message) => messages.push(message), jobLog: () => {}, log: () => {}, watchOptions: () => ({}), housekeeping: false });
  });
  afterEach(async () => {
    await service.stop(0);
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  it('accepts an index fence for an opted-in root and refuses a sibling', async () => {
    const root = path.join(workspace, 'root');
    const sibling = path.join(workspace, 'sibling');
    fs.mkdirSync(root);
    fs.mkdirSync(sibling);
    const optIn = { noGit: true, seeded: false };
    registerProject(root, optIn);
    await service.handle({ id: 1, op: 'fence', root, kind: 'index' });
    expect(messages).toContainEqual(expect.objectContaining({ id: 1, ok: true }));
    await service.handle({ id: 2, op: 'unfence', root });
    await service.handle({ id: 3, op: 'fence', root: sibling, kind: 'index' });
    expect(messages).toContainEqual(expect.objectContaining({ id: 3, ok: false }));
  });

  it('admits cliIndex for an opted-in root but refuses a plain sibling', async () => {
    const root = path.join(workspace, 'root');
    const sibling = path.join(workspace, 'sibling');
    fs.mkdirSync(root);
    fs.mkdirSync(sibling);
    const optIn = { noGit: true, seeded: false };
    registerProject(root, optIn);

    await service.handle({ id: 11, op: 'cliIndex', root: sibling, mode: 'init' });
    expect(messages).toContainEqual(expect.objectContaining({ id: 11, ok: false, error: expect.stringContaining('is not in a git repository') }));
    await service.handle({ id: 12, op: 'cliIndex', root, mode: 'init' });
    expect(messages).toContainEqual(expect.objectContaining({ id: 12, ok: true }));
    expect(messages).not.toContainEqual(expect.objectContaining({ id: 12, ok: false, error: expect.stringContaining('is not in a git repository') }));
  });
});
