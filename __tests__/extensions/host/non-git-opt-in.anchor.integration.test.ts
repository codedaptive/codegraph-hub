import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { indexRootAdmission, resolveRepoAnchor } from '../../../src/extensions/host/server/repo-anchor';

describe('non-git index root admission', () => {
  let workspace: string;
  beforeEach(() => {
    // '/tmp' keeps the workspace outside any git worktree whatever TMPDIR points at; Windows has no '/tmp'.
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cg-opted-anchor-')));
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  it('includes the opt-in command in a non-git index refusal', async () => {
    const root = path.join(workspace, 'plain');
    fs.mkdirSync(root);
    const refusal = await indexRootAdmission(await resolveRepoAnchor(workspace))(root);
    expect(refusal).toContain('is not in a git repository');
    expect(refusal).toContain('codegraph init');
    expect(refusal).toContain('--no-git');
  });
});
