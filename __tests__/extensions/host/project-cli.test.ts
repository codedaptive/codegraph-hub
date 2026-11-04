/**
 * `codegraph project` CLI (request worktree-lifecycle, vector G12).
 *
 * `project list [--json]`, `project pin <path>`, `project unpin <path>` and
 * `project remove <path>` drive the project registry
 * (src/extensions/host/worktree-lifecycle/project-registry.ts). `remove` only unregisters; it deletes nothing.
 *
 * Runs the BUILT binary, as __tests__/cli-unlock.test.ts does, so dist/ must be
 * rebuilt (`npm run build`) after the command changes. The child inherits the
 * home sandbox (__tests__/setup-home-sandbox.ts), so the registry it writes is
 * this file's throwaway ~/.codegraph/projects.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';

const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');

interface ListedProject { root: string; commonDir: string | null; flags: number; registeredAt: string }

/** One CLI run: no daemon, no wasm-flag re-exec (see extension-hooks-cli.test.ts). */
function runCli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function runOk(args: string[], cwd: string): string {
  const res = runCli(args, cwd);
  expect(res.status, `codegraph ${args.join(' ')}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(0);
  return res.stdout;
}

/** `project list --json`: an array of records, or `{ projects: [...] }`. */
function listJson(cwd: string): ListedProject[] {
  const parsed = JSON.parse(runOk(['project', 'list', '--json'], cwd)) as unknown;
  const list = Array.isArray(parsed) ? parsed : (parsed as { projects?: unknown }).projects;
  expect(Array.isArray(list)).toBe(true);
  return list as ListedProject[];
}

describe('codegraph project (G12)', () => {
  let tempDir: string;
  let root: string;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-project-cli-')));
    root = path.join(tempDir, 'app');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'app.ts'), 'export function appSymbol() { return 1; }\n');
    CodeGraph.initSync(root).close();
  });

  afterEach(() => {
    fs.rmSync(path.join(os.homedir(), '.codegraph', 'projects'), { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('pin registers a root as pinned and list shows it, as JSON and as text', () => {
    expect(listJson(tempDir)).toEqual([]);
    runOk(['project', 'pin', root], tempDir);

    const listed = listJson(tempDir);
    expect(listed).toHaveLength(1);
    expect(listed[0].root).toBe(fs.realpathSync.native(root));
    expect(listed[0].flags & 1).toBe(1);

    expect(runOk(['project', 'list'], tempDir)).toContain(fs.realpathSync.native(root));
  });

  it('unpin clears the pinned bit and keeps the root registered', () => {
    runOk(['project', 'pin', root], tempDir);
    runOk(['project', 'unpin', root], tempDir);

    const listed = listJson(tempDir);
    expect(listed).toHaveLength(1);
    expect(listed[0].root).toBe(fs.realpathSync.native(root));
    expect(listed[0].flags & 1).toBe(0);
  });

  it('remove unregisters the root and deletes nothing', () => {
    runOk(['project', 'pin', root], tempDir);
    runOk(['project', 'remove', root], tempDir);

    expect(listJson(tempDir)).toEqual([]);
    expect(fs.existsSync(path.join(root, '.codegraph', 'codegraph.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'app.ts'))).toBe(true);
  });
});
