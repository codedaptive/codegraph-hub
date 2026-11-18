import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { BuilderService } from '../../../src/extensions/host/builder/service';
import { registerProject } from '../../../src/extensions/host/worktree-lifecycle/project-registry';

describe('builder ensure on an indexed non-git folder', { timeout: 60_000 }, () => {
  let workspace: string;
  let root: string;
  let service: BuilderService;

  beforeEach(async () => {
    // '/tmp' keeps the workspace outside any git worktree whatever TMPDIR points at; Windows has no '/tmp'.
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cg-opted-ensure-')));
    vi.stubEnv('HOME', workspace);
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    root = path.join(workspace, 'root');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function alphaSymbol() { return 1; }\n');
    const cg = await CodeGraph.init(root);
    try { await cg.indexAll(); } finally { cg.close(); }
    service = new BuilderService({
      send: () => {}, jobLog: () => {}, log: () => {}, watchOptions: () => ({}), housekeeping: false,
    });
  });

  afterEach(async () => {
    await service?.stop(0);
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('holds an indexed folder opted in with no-git', async () => {
    registerProject(root, { noGit: true, seeded: false });
    expect([{ kind: 'ready', root }, { kind: 'building', root }]).toContainEqual(await service.ensure(root));
  });

  it('does not hold an indexed folder without opt-in', async () => {
    expect(await service.ensure(root)).toEqual({ kind: 'none' });
  });
});
