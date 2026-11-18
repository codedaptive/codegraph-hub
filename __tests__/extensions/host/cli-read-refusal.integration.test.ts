import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { gitInitTempRoot } from '../../helpers/git-init-temp-root';

const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');
const SYMBOL = 'refusalFixtureSymbol';
const FILE = 'fixture.ts';
const SOURCE = 'export function refusalFixtureSymbol() { return 42; }\n';

describe('CLI read opt-in', { timeout: 180_000 }, () => {
  let workspace: string;
  let gitRoot: string;
  let stray: string;
  let optedIn: string;
  let uninitialized: string;

  function runCli(args: string[]) {
    return spawnSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1',
        CODEGRAPH_NO_PROMPT_HOOK: '1', CODEGRAPH_TELEMETRY: '0',
        DO_NOT_TRACK: '1', NO_COLOR: '1', NODE_NO_WARNINGS: '1',
      },
    });
  }

  beforeAll(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cg-cli-read-')));
    const home = path.join(workspace, 'home');
    fs.mkdirSync(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    gitRoot = path.join(workspace, 'git');
    stray = path.join(workspace, 'stray');
    optedIn = path.join(workspace, 'opted');
    uninitialized = path.join(workspace, 'uninitialized');
    for (const dir of [gitRoot, stray, optedIn, uninitialized]) fs.mkdirSync(dir);
    gitRoot = gitInitTempRoot(gitRoot);
    fs.writeFileSync(path.join(gitRoot, FILE), SOURCE);
    const cg = CodeGraph.initSync(gitRoot);
    try { await cg.indexAll(); } finally { cg.close(); }
    fs.cpSync(path.join(gitRoot, '.codegraph'), path.join(stray, '.codegraph'), { recursive: true });
    fs.copyFileSync(path.join(gitRoot, FILE), path.join(stray, FILE));
    fs.writeFileSync(path.join(optedIn, FILE), SOURCE);
  }, 180_000);

  afterAll(() => {
    vi.unstubAllEnvs();
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  const reads: Array<[string, (root: string) => string[]]> = [
    ['query', root => ['query', SYMBOL, '-p', root]],
    ['explore', root => ['explore', SYMBOL, '-p', root]],
    ['context', root => ['context', SYMBOL, '-p', root]],
    ['node', root => ['node', SYMBOL, '-p', root]],
    ['files', root => ['files', '-p', root]],
    ['callers', root => ['callers', SYMBOL, '-p', root]],
    ['callees', root => ['callees', SYMBOL, '-p', root]],
    ['impact', root => ['impact', SYMBOL, '-p', root]],
    ['implementations', root => ['implementations', SYMBOL, '-p', root]],
    ['affected', root => ['affected', FILE, '-p', root]],
    ['cycles', root => ['cycles', root]],
    ['status', root => ['status', root]],
    ['checkpoint', root => ['checkpoint', root]],
  ];

  it.each(reads)('refuses %s on an initialized non-git folder without opt-in', (_name, args) => {
    const result = runCli(args(stray));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('is not in a git repository');
    expect(result.stdout + result.stderr).toContain('--no-git');
    expect(result.stdout).not.toContain(FILE);
  });

  it('serves a non-git folder opted in through init --no-git', () => {
    const init = runCli(['init', optedIn, '--no-git', '--yes']);
    expect(init.error).toBeUndefined();
    expect(init.status, init.stdout + init.stderr).toBe(0);
    const query = runCli(['query', SYMBOL, '-p', optedIn]);
    expect(query.error).toBeUndefined();
    expect(query.status, query.stdout + query.stderr).toBe(0);
    expect(query.stdout).toContain(SYMBOL);
    expect(query.stdout).toContain(FILE);
  });

  it('serves an indexed git worktree', () => {
    const result = runCli(['query', SYMBOL, '-p', gitRoot]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(SYMBOL);
    expect(result.stdout).toContain(FILE);
  });

  it('reports not initialized for an uninitialized non-git folder', () => {
    const result = runCli(['query', SYMBOL, '-p', uninitialized]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('not initialized');
  });
});
