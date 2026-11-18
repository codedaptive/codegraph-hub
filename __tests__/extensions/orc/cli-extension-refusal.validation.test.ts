/**
 * Validation (S-86): the built CLI's extension commands refuse a stray index (S-84).
 *
 * Measures: `suspects`, `grep`, `blast` and `orphans` from dist/bin/codegraph.js on a folder outside git that holds
 * a copied `.codegraph/` but was never opted in. Threshold: each exits 1, prints nothing on stdout, and gives the
 * not-a-repository refusal naming `--no-git` on stderr. Source: S-84 (team/settled.md: the CLI extension commands
 * refuse a non-git, non-opted-in path like host's reads), S-85 (CLI reads exit 1), R-46/R-50.
 * Control: the same `grep` and `suspects` on the indexed git root it was copied from answer (exit 0).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { gitInitTempRoot } from '../../helpers/git-init-temp-root';

const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');
const TOKEN = 'refusalExtensionToken';
const FILE = 'fixture.ts';
const SOURCE = `export function ${TOKEN}() { return "${TOKEN}"; }\n`;

function runCli(args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1',
      CODEGRAPH_NO_PROMPT_HOOK: '1', CODEGRAPH_TELEMETRY: '0',
      DO_NOT_TRACK: '1', NO_COLOR: '1', NODE_NO_WARNINGS: '1',
    },
  });
}

describe('CLI extension commands on a stray index (S-84)', { timeout: 180_000 }, () => {
  let workspace: string;
  let gitRoot: string;
  let stray: string;

  beforeAll(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cg-ext-refusal-')));
    const home = path.join(workspace, 'home');
    fs.mkdirSync(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    gitRoot = path.join(workspace, 'git');
    stray = path.join(workspace, 'stray');
    fs.mkdirSync(gitRoot);
    fs.mkdirSync(stray);
    gitRoot = gitInitTempRoot(gitRoot);
    fs.writeFileSync(path.join(gitRoot, FILE), SOURCE);
    const cg = CodeGraph.initSync(gitRoot);
    try { await cg.indexAll(); } finally { cg.close(); }
    fs.cpSync(path.join(gitRoot, '.codegraph'), path.join(stray, '.codegraph'), { recursive: true });
    fs.copyFileSync(path.join(gitRoot, FILE), path.join(stray, FILE));
  }, 180_000);

  afterAll(() => {
    vi.unstubAllEnvs();
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  const commands: Array<[string, (root: string) => string[]]> = [
    ['suspects', root => ['suspects', '-p', root]],
    ['grep', root => ['grep', TOKEN, '--path', root]],
    ['blast', root => ['blast', '--path', root]],
    ['orphans', root => ['orphans', '--path', root, '--base', 'HEAD']],
  ];

  it.each(commands)('%s refuses the stray index: exit 1, empty stdout, the refusal on stderr', (_name, args) => {
    const result = runCli(args(stray));
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('is not in a git repository');
    expect(result.stderr).toContain('--no-git');
  });

  it.each(commands.filter(([name]) => name === 'grep' || name === 'suspects'))(
    '%s answers the indexed git root the stray index was copied from',
    (_name, args) => {
      const result = runCli(args(gitRoot));
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stderr).not.toContain('is not in a git repository');
    },
  );
});
