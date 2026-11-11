/**
 * `codegraph orphans` wired through the extension hook: the queries zone's
 * `src/extensions/queries/extension.ts` contributes the `orphans` CLI command
 * and the `codegraph_orphans` MCP tool (./orphans/extension).
 *
 * Two parts:
 *   - startup cost (dist/extensions/queries/orphans/extension.js required
 *     alone in a child `node`): the registration loads none of the report's
 *     code, so `require.cache` holds no dist/index.js, nothing under dist/db/
 *     and no web-tree-sitter;
 *   - built binary (dist/bin/codegraph.js), as blast-extension.integration.test.ts: the
 *     zone module found by the hook's discovery under dist/extensions/, with
 *     CODEGRAPH_EXTENSION_MODULES removed from the child's env so nothing else
 *     can supply it.
 *
 * Fixture: C1 (tagged) holds src/util.ts with `helper`, called from src/a.ts;
 * C2 appends the uncalled `lonelyNew` to src/util.ts, so the report has one
 * orphan. Indexing two files is cheap, so it is built once in beforeAll.
 * This file holds the spawned-process half; the in-process half is orphans-extension-inprocess.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../../../src';

const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');

/** Run git in `root` with a local identity; throws on failure so a broken fixture is loud. */
function git(root: string, ...args: string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=orphans-test', '-c', 'user.email=orphans-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
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
let firstLine = '';

beforeAll(async () => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphans-ext-')));
  git(repo, 'init', '-q');
  write(repo, 'src/util.ts', UTIL);
  write(repo, 'src/a.ts', A);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'C1');
  git(repo, 'tag', 'C1');
  firstLine = `orphans — C1...HEAD (merge base ${git(repo, 'rev-parse', '--short=7', 'C1').trim()})`;
  write(repo, 'src/util.ts', `${UTIL}\nexport function lonelyNew(): number {\n  return 5;\n}\n`);
  git(repo, 'commit', '-q', '-am', 'C2: add lonelyNew');
  const cg = await CodeGraph.init(repo);
  await cg.indexAll();
  cg.close();
}, 30_000);

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
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

describe("orphans' registration adds nothing to startup (built module, child node)", () => {
  const DIST = path.resolve(__dirname, '../../../dist');
  const EXT = path.join(DIST, 'extensions', 'queries', 'orphans', 'extension.js');
  /** Requires the module named by argv[1] with Node's own require and prints its exports and the require cache. */
  const PROBE =
    'const m = require(process.argv[1]);' +
    'process.stdout.write(JSON.stringify({ exports: Object.keys(m), cache: Object.keys(require.cache) }));';

  it('requiring orphans/extension.js alone loads no dist/index.js, nothing under dist/db/, dist/resolution/ or dist/extraction/, and no web-tree-sitter', () => {
    const res = spawnSync(process.execPath, ['-e', PROBE, EXT], { encoding: 'utf-8', env: childEnv() });
    expect(res.status, res.stderr).toBe(0);
    const { exports, cache } = JSON.parse(res.stdout) as { exports: string[]; cache: string[] };
    expect(exports).toEqual(expect.arrayContaining(['orphansTool', 'registerOrphansCommand']));
    // Cache keys are real paths.
    const dist = fs.realpathSync(DIST);
    expect(cache).toContain(fs.realpathSync(EXT));
    expect(cache).not.toContain(path.join(dist, 'index.js'));
    expect(cache.filter((k) => k.startsWith(path.join(dist, 'db') + path.sep))).toEqual([]);
    expect(cache.filter((k) => k.startsWith(path.join(dist, 'resolution') + path.sep))).toEqual([]);
    expect(cache.filter((k) => k.startsWith(path.join(dist, 'extraction') + path.sep))).toEqual([]);
    expect(cache.filter((k) => k.includes(`${path.sep}web-tree-sitter${path.sep}`))).toEqual([]);
  });
});

describe('codegraph orphans (built binary, zone module found by discovery)', () => {
  it('--help lists orphans', () => {
    const res = cli(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^\s+orphans\b/m);
  });

  it('orphans --base C1 -p <repo> prints the text report and exits 0', () => {
    const res = cli(['orphans', '--base', 'C1', '-p', repo]);
    expect(res.status).toBe(0);
    const lines = res.stdout.split('\n');
    expect(lines[0]).toBe(firstLine);
    expect(lines.some((l) => l.startsWith('orphaned ('))).toBe(true);
    expect(lines.some((l) => l.startsWith('orphaned unless the guess is right ('))).toBe(true);
    expect(lines.some((l) => l.startsWith('excluded:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('added symbols:'))).toBe(true);
    expect(res.stdout).toContain('lonelyNew');
  });

  it('orphans --json prints parseable JSON', () => {
    const res = cli(['orphans', '--base', 'C1', '--json', '-p', repo]);
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout) as { basis: string; orphans: { name: string }[] };
    expect(report.basis).toBe('C1...HEAD');
    expect(report.orphans.map((o) => o.name)).toContain('lonelyNew');
  });

  it('orphans with no --base exits 1 with a message on stderr naming --base', () => {
    const res = cli(['orphans', '-p', repo]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--base');
    expect(res.stdout).toBe('');
  });

  it('orphans --base nope exits 1 with the message on stderr and nothing on stdout', () => {
    const res = cli(['orphans', '--base', 'nope', '-p', repo]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('nope');
    expect(res.stdout).toBe('');
  });
});
