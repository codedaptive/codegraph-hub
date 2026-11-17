/**
 * `codegraph index <path>` rebuilds the git worktree root <path> belongs to,
 * never the nearest initialized ancestor (#1524, S-70).
 *
 * codegraph indexes only git worktrees, so a <path> below a worktree root acts
 * on that root: `codegraph index child`, run on a directory inside the
 * `parent` worktree, rebuilds `parent` and creates no index of its own in
 * `child`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { gitInitTempRoot } from './helpers/git-init-temp-root';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function run(cwd: string, args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
  });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

describe('codegraph index <path> (#1524)', () => {
  let root: string;
  let parent: string;
  let child: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-index-path-'));
    fs.mkdirSync(path.join(root, 'parent', 'child'), { recursive: true });
    parent = gitInitTempRoot(path.join(root, 'parent'));
    child = path.join(parent, 'child');
    fs.writeFileSync(path.join(parent, 'p.py'), 'def parent_only():\n    return 1\n');
    fs.writeFileSync(path.join(child, 'c.py'), 'def child_only():\n    return 2\n');
    const cg = CodeGraph.initSync(parent);
    await cg.indexAll();
    cg.close();
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('an explicit path below the worktree root rebuilds that root and creates no index of its own', () => {
    const r = run(root, ['index', child, '--quiet']);
    // `child` has no index of its own, so exit 0 means the parent root was rebuilt.
    expect(r.status, r.out).toBe(0);
    expect(fs.existsSync(path.join(parent, '.codegraph', 'codegraph.db'))).toBe(true);
    expect(fs.existsSync(path.join(child, '.codegraph'))).toBe(false);
  });

  it('rebuilds the explicit path when it is initialized, and a bare `index` still resolves upward from a subdirectory', () => {
    expect(run(root, ['index', parent, '--quiet']).status).toBe(0);
    expect(run(child, ['index', '--quiet']).status).toBe(0);
  });
});
