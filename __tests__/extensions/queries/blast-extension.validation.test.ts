/**
 * `codegraph blast` wired through the extension hook: the queries zone's
 * `src/extensions/queries/extension.ts` contributes the `blast` CLI command and
 * the `codegraph_blast` MCP tool.
 *
 * Built binary (dist/bin/codegraph.js): the zone module found by the
 * hook's discovery under dist/extensions/, with CODEGRAPH_EXTENSION_MODULES
 * removed from the child's env so nothing else can supply it. Startup cost:
 * the built zone modules, required alone in a child `node`, load none of
 * dist/index.js, dist/db/, dist/resolution/ or dist/extraction/.
 *
 * The main fixture is a cut-down blast.integration.test.ts repo A (util.ts and a.ts only):
 * C1 (tagged), then C2 edits the body of `helper`, which `useA` calls. A second
 * fixture is a parent repo whose `.gitignore` leaves out `vendor/`, holding
 * `vendor/child`, an independent git repository with its own commit and no
 * index. Indexing two files is cheap, so both are built once in beforeAll.
 * This file holds the spawned-process half; the in-process half is blast-extension-inprocess.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../../../src';

const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');
const FIRST_LINE = 'blast radius — C1...HEAD (depth 2)';

/** Run git in `root` with a local identity; throws on failure so a broken fixture is loud. */
function git(root: string, ...args: string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=blast-test', '-c', 'user.email=blast-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const UTIL = 'export function helper(): number {\n  return 1;\n}\n';
const A = "import { helper } from './util';\n\nexport function useA(): number {\n  return helper();\n}\n";

let repo = '';
let parent = '';
let child = '';

beforeAll(async () => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-ext-')));
  git(repo, 'init', '-q');
  write(repo, 'src/util.ts', UTIL);
  write(repo, 'src/a.ts', A);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'C1');
  git(repo, 'tag', 'C1');
  write(repo, 'src/util.ts', UTIL.replace('return 1;', 'return 42;'));
  git(repo, 'commit', '-q', '-am', 'C2: helper body');
  const cg = await CodeGraph.init(repo);
  await cg.indexAll();
  cg.close();

  parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-nested-')));
  git(parent, 'init', '-q');
  write(parent, '.gitignore', 'vendor/\n');
  write(parent, 'src/util.ts', UTIL);
  git(parent, 'add', '-A');
  git(parent, 'commit', '-q', '-m', 'P1');
  child = path.join(parent, 'vendor', 'child');
  fs.mkdirSync(child, { recursive: true });
  git(child, 'init', '-q');
  write(child, 'lib.ts', 'export function vendored(): number {\n  return 7;\n}\n');
  git(child, 'add', '-A');
  git(child, 'commit', '-q', '-m', 'V1');
  const pcg = await CodeGraph.init(parent);
  await pcg.indexAll();
  pcg.close();
}, 30_000);

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
  if (parent) fs.rmSync(parent, { recursive: true, force: true });
});

/** Base env for one fast child: no daemon, no wasm-flag re-exec, and no extension module but what discovery finds. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEGRAPH_NO_DAEMON: '1',
    CODEGRAPH_WASM_RELAUNCHED: '1',
    CODEGRAPH_ALLOW_UNSAFE_NODE: '1',
  };
  delete env.CODEGRAPH_EXTENSION_MODULES;
  delete env.CODEGRAPH_MCP_TOOLS;
  return env;
}

function cli(args: string[], cwd?: string) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf-8',
    env: childEnv(),
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('codegraph blast (built binary, zone module found by discovery)', () => {
  it('--help lists blast', () => {
    const res = cli(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^\s+blast\b/m);
  });

  it('blast --base C1 -p <repo> prints the text report and exits 0', () => {
    const res = cli(['blast', '--base', 'C1', '-p', repo]);
    expect(res.status).toBe(0);
    expect(res.stdout.split('\n')[0]).toBe(FIRST_LINE);
    expect(res.stdout).toContain('useA');
  });

  it('blast --format json prints JSON with depth 2', () => {
    const res = cli(['blast', '--base', 'C1', '--format', 'json', '-p', repo]);
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout) as { depth: number; basis: string };
    expect(report.depth).toBe(2);
    expect(report.basis).toBe('C1...HEAD');
  });

  it('blast --base nope exits 1 with the message on stderr and nothing on stdout', () => {
    const res = cli(['blast', '--base', 'nope', '-p', repo]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('base ref "nope" is not in this checkout');
    expect(res.stdout).toBe('');
  });

  it('blast with no -p uses the working directory (a subdirectory resolves to its project)', () => {
    const atRoot = cli(['blast', '--base', 'C1'], repo);
    expect(atRoot.status).toBe(0);
    expect(atRoot.stdout.split('\n')[0]).toBe(FIRST_LINE);
    const inSub = cli(['blast', '--base', 'C1'], path.join(repo, 'src'));
    expect(inSub.status).toBe(0);
    expect(inSub.stdout.split('\n')[0]).toBe(FIRST_LINE);
  });

  it('blast -p <parent>/vendor/child (an ignored nested repository) exits 1 with the no-index message', () => {
    const res = cli(['blast', '-p', child]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`no CodeGraph index at ${child}`);
    expect(res.stdout).toBe('');
  });

  it('blast run from inside the ignored nested repository with no -p gives the same answer', () => {
    const res = cli(['blast'], child);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`no CodeGraph index at ${child}`);
  });

  it('blast -p <parent>/src (an ordinary subdirectory) still resolves to the parent index', () => {
    const res = cli(['blast', '-p', path.join(parent, 'src')]);
    expect(res.status).toBe(0);
    expect(res.stdout.split('\n')[0]).toBe('blast radius — working tree vs HEAD (depth 2)');
  });
});

describe('blast registration is light (built modules)', () => {
  // The host loads the zone module on every CLI call and in every query-pool
  // worker, so loading it must not pull in the engine (src/index), the
  // database layer, the resolver or the extractors (src/db, src/resolution,
  // src/extraction); those are imported inside the action and the handler.
  for (const rel of ['extensions/queries/blast/extension.js', 'extensions/queries/extension.js']) {
    it(`requiring dist/${rel} loads none of dist/index.js, dist/db/, dist/resolution/, dist/extraction/`, () => {
      // Real path: require.cache keys are physical paths, so a symlinked dist must not hide a load.
      const distRoot = fs.realpathSync(path.resolve(__dirname, '../../../dist'));
      const script =
        `require(${JSON.stringify(path.join(distRoot, rel))});` +
        'process.stdout.write(JSON.stringify(Object.keys(require.cache)));';
      const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', env: childEnv() });
      expect(res.status, res.stderr).toBe(0);
      const loaded: string[] = JSON.parse(res.stdout);
      const heavy = loaded.filter(
        (p) =>
          p === path.join(distRoot, 'index.js') ||
          ['db', 'resolution', 'extraction'].some((d) => p.startsWith(path.join(distRoot, d) + path.sep)),
      );
      expect(heavy).toEqual([]);
    });
  }
});
