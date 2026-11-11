/**
 * `codegraph orphans` wired through the extension hook: the queries zone's
 * `src/extensions/queries/extension.ts` contributes the `orphans` CLI command
 * and the `codegraph_orphans` MCP tool (./orphans/extension).
 *
 * In-process (src), as blast-extension-inprocess.integration.test.ts: the zone's default export
 * registered with `registerExtension`, then listed and executed through
 * `ToolHandler`.
 * Spawned-process tests are in orphans-extension.integration.test.ts.
 *
 * Fixture: C1 (tagged) holds src/util.ts with `helper`, called from src/a.ts;
 * C2 appends the uncalled `lonelyNew` to src/util.ts, so the report has one
 * orphan. Indexing two files is cheap, so it is built once in beforeAll.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Command } from 'commander';
import { CodeGraph } from '../../../src';
import { ToolHandler, getStaticTools } from '../../../src/mcp/tools';
import { __resetExtensionsForTests, registerExtension } from '../../../src/extensions/host/registry';
import queriesExtension from '../../../src/extensions/queries/extension';
import { orphansTool, registerOrphansCommand } from '../../../src/extensions/queries/orphans/extension';

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

describe('orphans description pins', () => {
  it('tool describes the working tree diff', () => {
    const description = orphansTool.definition.description;
    expect(description).toMatch(/working tree/i);
    expect(description).toMatch(/uncommitted/i);
    expect(description).toMatch(/from the merge base of a base git ref and HEAD to the working tree/i);
  });

  it('tool says untracked files are excluded', () => {
    expect(orphansTool.definition.description).toMatch(/untracked files excluded/i);
  });

  it('tool names Go and Python entry points', () => {
    const description = orphansTool.definition.description;
    expect(description).toMatch(/\binit\b/);
    expect(description).toMatch(/dunder/i);
    expect(description).toMatch(/__getattr__/);
    expect(description).toMatch(/__dir__/);
  });

  it('CLI describes the working tree diff', () => {
    const program = new Command();
    registerOrphansCommand(program);
    const description = program.commands.find((command) => command.name() === 'orphans')!.description();
    expect(description).toMatch(/working tree/i);
    expect(description).toMatch(/uncommitted/i);
    expect(description).toMatch(/from the merge base of a base ref and HEAD to the working tree/i);
  });
});

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

describe('codegraph_orphans through ToolHandler (in-process)', () => {
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    __resetExtensionsForTests();
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,orphans');
    registerExtension(queriesExtension);
  });

  afterEach(() => {
    cg?.close();
    cg = null;
    vi.unstubAllEnvs();
    __resetExtensionsForTests();
  });

  const names = (defs: Array<{ name: string }>) => defs.map((t) => t.name);

  it('the zone extension carries orphansTool under the name codegraph_orphans', () => {
    expect(orphansTool.definition.name).toBe('codegraph_orphans');
    expect(queriesExtension.tools).toContain(orphansTool);
  });

  it('orphansTool sets no annotations of its own (the registry sets them)', () => {
    expect(orphansTool.definition).not.toHaveProperty('annotations');
  });

  it('lists codegraph_orphans when the allowlist names orphans', async () => {
    expect(names(getStaticTools())).toContain('codegraph_orphans');
    cg = await CodeGraph.open(repo);
    expect(names(new ToolHandler(cg).getTools())).toContain('codegraph_orphans');
  });

  it('reports the symbols added since C1 that nothing uses', async () => {
    cg = await CodeGraph.open(repo);
    const res = await new ToolHandler(cg).execute('codegraph_orphans', { projectPath: repo, base: 'C1' });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text.split('\n')[0]).toBe(firstLine);
    expect(text).toContain('lonelyNew');
    expect(text).not.toContain('helper');
  });

  it("format 'json' answers parseable JSON listing lonelyNew as an orphan", async () => {
    cg = await CodeGraph.open(repo);
    const res = await new ToolHandler(cg).execute('codegraph_orphans', { projectPath: repo, base: 'C1', format: 'json' });
    expect(res.isError).toBeFalsy();
    const report = JSON.parse(res.content[0].text) as { basis: string; added: number; orphans: { name: string }[] };
    expect(report.basis).toBe('C1...HEAD');
    expect(report.added).toBe(1);
    expect(report.orphans.map((o) => o.name)).toEqual(['lonelyNew']);
  });

  it('answers a missing base with success-shaped guidance naming base, not isError', async () => {
    cg = await CodeGraph.open(repo);
    const res = await new ToolHandler(cg).execute('codegraph_orphans', { projectPath: repo });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/base/);
  });

  it('answers a non-string base with success-shaped guidance naming base, not isError', async () => {
    cg = await CodeGraph.open(repo);
    const res = await new ToolHandler(cg).execute('codegraph_orphans', { projectPath: repo, base: 7 });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/base/);
  });

  it('answers an unknown base ref with success-shaped guidance naming the ref, not isError', async () => {
    cg = await CodeGraph.open(repo);
    const res = await new ToolHandler(cg).execute('codegraph_orphans', { projectPath: repo, base: 'nope' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('nope');
  });
});
