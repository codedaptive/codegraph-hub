// Validation: runs the built binary to measure R-50's non-git opt-in lifecycle.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Fixtures } from '../host/machine-server.harness';

const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');
const ALPHA = 'export function alphaSymbol() { return 1; }\n';
const fx = new Fixtures();
let workspace: string;
let root: string;
let state: string;
let home: string;

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home, USERPROFILE: home, CODEGRAPH_STATE_DIR: state,
    CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_PROMPT_HOOK: '1',
    CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NODE_NO_WARNINGS: '1', NO_COLOR: '1',
  };
}

function cli(...args: string[]) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: workspace, env: env(), encoding: 'utf8', timeout: 240_000,
  });
  expect(result.error, `CLI ${args.join(' ')} failed to run`).toBeUndefined();
  expect(result.status, `CLI ${args.join(' ')} terminated by ${result.signal}`).not.toBeNull();
  return result;
}

function output(result: ReturnType<typeof cli>): string {
  return (result.stdout + result.stderr).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function projects(): Array<{ root: string; flags: number }> {
  const result = cli('project', 'list', '--json');
  expect(result.status, output(result)).toBe(0);
  return JSON.parse(result.stdout);
}

async function search(projectPath: string) {
  const session = fx.session({ cwd: workspace, stateDir: state, env: {
    HOME: home, USERPROFILE: home, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_PROMPT_HOOK: '1',
    CODEGRAPH_WASM_RELAUNCHED: '1', NODE_NO_WARNINGS: '1', NO_COLOR: '1',
  } });
  try {
    await session.initialize();
    return await session.tool('codegraph_search', { query: 'alphaSymbol', projectPath }, 240_000);
  } finally {
    await session.end();
  }
}

// The cases deliberately share state and run in lifecycle order.
describe.sequential('R-50 non-git opt-in', { timeout: 600_000 }, () => {
  beforeAll(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orc-nongit-')));
    const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workspace, encoding: 'utf8' });
    if (git.error || git.status === 0 || git.stdout.trim() === 'true') {
      throw new Error(`workspace must be outside git: status=${git.status} stdout=${git.stdout} error=${git.error}`);
    }
    root = path.join(workspace, 'plain');
    state = path.join(workspace, 'state');
    home = path.join(workspace, 'home');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), ALPHA);
  });

  afterAll(async () => {
    await fx.teardown();
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  }, 600_000);

  // Measures R-50 items 1-2: init without --no-git is refused and writes nothing; with it, the folder is indexed, listed no-git and answered by CLI and MCP. Passes when all of those hold.
  it('requires explicit opt-in, records no-git, and serves the indexed symbol via CLI and MCP', async () => {
    const refused = cli('init', root, '--yes');
    expect(refused.status, output(refused)).not.toBe(0);
    expect(output(refused)).toContain('--no-git');
    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);

    const init = cli('init', root, '--no-git', '--yes');
    expect(init.status, output(init)).toBe(0);
    expect(fs.existsSync(path.join(root, '.codegraph', 'codegraph.db'))).toBe(true);
    const list = cli('project', 'list');
    expect(list.status, output(list)).toBe(0);
    expect(list.stdout.split(/\r?\n/).some(line => line.includes(root) && line.includes('no-git')), list.stdout).toBe(true);
    expect(projects().some(p => p.root === root && (p.flags & 4) !== 0)).toBe(true);
    const query = cli('query', 'alphaSymbol', '-p', root);
    expect(query.status, output(query)).toBe(0);
    expect(query.stdout).toContain('alphaSymbol');
    expect(query.stdout).toContain('src/a.ts');
    const answer = await search(root);
    expect(answer.rpcError).toBeNull();
    expect(answer.isError, answer.text).toBe(false);
    expect(answer.text).toContain('alphaSymbol');
    expect(answer.text).toContain('src/a.ts');
  });

  // Measures R-50 item 2 (synced like a git worktree root): a symbol added after init is absent from query until `sync`, present after. Passes when both queries answer so.
  it('syncs a newly added symbol only after sync', () => {
    fs.appendFileSync(path.join(root, 'src', 'a.ts'), 'export function betaSymbol() { return 2; }\n');
    const before = cli('query', 'betaSymbol', '-p', root);
    expect(before.status, output(before)).toBe(0);
    expect(before.stdout).toContain('No results found for "betaSymbol"');
    const sync = cli('sync', root);
    expect(sync.status, output(sync)).toBe(0);
    const after = cli('query', 'betaSymbol', '-p', root);
    expect(after.status, output(after)).toBe(0);
    expect(after.stdout).toContain('betaSymbol');
    expect(after.stdout).toContain('src/a.ts');
  });

  // Measures R-50 items 1 and 3: uninit removes .codegraph and the opt-in, and the MCP call then gets success-shaped not-a-repository guidance rather than a build. Passes when none is left and the answer names --no-git.
  it('uninit clears the index and opt-in and MCP gives success-shaped opt-in guidance', async () => {
    const uninit = cli('uninit', '--force', root);
    expect(uninit.status, output(uninit)).toBe(0);
    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
    expect(projects().some(p => p.root === root && (p.flags & 4) !== 0)).toBe(false);
    const list = cli('project', 'list');
    expect(list.status, output(list)).toBe(0);
    expect(list.stdout).not.toContain(root);
    const answer = await search(root);
    expect(answer.rpcError).toBeNull();
    expect(answer.isError, answer.text).toBe(false);
    expect(answer.text).toContain('not in a git repository');
    expect(answer.text).toContain('codegraph init');
    expect(answer.text).toContain('--no-git');
    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
    expect(projects().some(p => p.root === root && (p.flags & 4) !== 0)).toBe(false);
  });

  // Measures R-50 items 2 and 5: a copied .codegraph with no registry opt-in is not served, and `init --force` does not opt in. Passes when the MCP answer is guidance, init exits non-zero and no no-git record exists.
  it('refuses a copied index and --force without an opt-in', async () => {
    const donor = path.join(workspace, 'donor');
    const stray = path.join(workspace, 'stray');
    fs.mkdirSync(path.join(donor, 'src'), { recursive: true });
    fs.mkdirSync(path.join(stray, 'src'), { recursive: true });
    fs.writeFileSync(path.join(donor, 'src', 'a.ts'), ALPHA);
    fs.writeFileSync(path.join(stray, 'src', 'a.ts'), ALPHA);
    const init = cli('init', donor, '--no-git', '--yes');
    expect(init.status, output(init)).toBe(0);
    fs.cpSync(path.join(donor, '.codegraph'), path.join(stray, '.codegraph'), { recursive: true });
    const answer = await search(stray);
    expect(answer.rpcError).toBeNull();
    expect(answer.isError, answer.text).toBe(false);
    expect(answer.text).not.toContain('alphaSymbol');
    expect(answer.text).toContain('--no-git');
    const forced = cli('init', '--force', stray, '--yes');
    expect(forced.status, output(forced)).not.toBe(0);
    expect(output(forced)).toContain('--no-git');
    expect(projects().some(p => p.root === stray && (p.flags & 4) !== 0)).toBe(false);
  });
});
