/**
 * `codegraph suspects` wired through the extension hook: the resolution zone's
 * `src/extensions/resolution/extension.ts` contributes the `suspects` CLI command
 * and the `codegraph_suspects` MCP tool, both over findSuspects (./suspects).
 *
 * Two halves:
 *   - in-process (src): the zone's default export registered with
 *     `registerExtension`, then listed and executed through `ToolHandler`;
 *   - built binary (dist/bin/codegraph.js): the zone module found by the
 *     hook's discovery under dist/extensions/, with CODEGRAPH_EXTENSION_MODULES
 *     removed from the child's env so nothing else can supply it.
 *
 * The fixture is suspects.test.ts's Rust std-collision project: `run` calls
 * `push` and `clear` on a value the resolver binds to the project's `Stack`, so
 * the index yields two suspect targets with one call edge each. It is indexed
 * once in beforeAll; a second temp dir with no index serves the not-indexed cases.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../../../src';
import { ToolHandler, getStaticTools } from '../../../src/mcp/tools';
import { __resetExtensionsForTests, registerExtension } from '../../../src/extensions/host/registry';
import { findSuspects, formatSuspects } from '../../../src/extensions/resolution/suspects';
import resolutionExtension, { suspectsTool } from '../../../src/extensions/resolution/extension';

const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');
const HEADER = /^\d+ suspect targets \(\d+ call edges\)$/;

interface SuspectsJson {
  version: number;
  suspects: Array<{ targetId: string; edgeCount: number; edges: unknown[] }>;
}

let project = '';
let unindexed = '';

beforeAll(async () => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-suspects-ext-')));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n',
    'src/main.rs': 'mod stack;\n\nfn run() {\n    let mut stack = build();\n    stack.push(1);\n    stack.clear();\n}\n',
    'src/stack.rs': 'pub struct Stack { items: Vec<i32> }\n\nimpl Stack {\n    pub fn push(&mut self, x: i32) { }\n    pub fn clear(&mut self) { }\n}\n',
  };
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), source);
  }
  const cg = await CodeGraph.init(project, { index: true });
  cg.close();
  // The fixture must give at least two targets, or the limit vectors prove nothing.
  expect(findSuspects(project).length).toBeGreaterThanOrEqual(2);

  unindexed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-suspects-ext-none-')));
}, 30_000);

afterAll(() => {
  if (project) fs.rmSync(project, { recursive: true, force: true });
  if (unindexed) fs.rmSync(unindexed, { recursive: true, force: true });
});

describe('codegraph_suspects through ToolHandler (in-process)', () => {
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    __resetExtensionsForTests();
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    registerExtension(resolutionExtension);
  });

  afterEach(() => {
    cg?.close();
    cg = null;
    vi.unstubAllEnvs();
    __resetExtensionsForTests();
  });

  const names = (defs: Array<{ name: string }>) => defs.map((t) => t.name);

  async function run(args: Record<string, unknown>) {
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,suspects');
    cg = await CodeGraph.open(project);
    return new ToolHandler(cg).execute('codegraph_suspects', args);
  }

  it('is off by default: not listed with no CODEGRAPH_MCP_TOOLS', () => {
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', '');
    delete process.env.CODEGRAPH_MCP_TOOLS;
    expect(names(getStaticTools())).not.toContain('codegraph_suspects');
  });

  it('is listed when the allowlist names suspects', () => {
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,suspects');
    expect(names(getStaticTools())).toContain('codegraph_suspects');
  });

  it('declares projectPath, limit, maxEdgesPerTarget and format in its input schema', () => {
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,suspects');
    const def = getStaticTools().find((t) => t.name === 'codegraph_suspects');
    expect(def).toBeDefined();
    const props = (def!.inputSchema as { properties: Record<string, { type?: unknown; enum?: unknown }> }).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['projectPath', 'limit', 'maxEdgesPerTarget', 'format']));
    expect(props.format!.enum).toEqual(['text', 'json']);
  });

  it('returns the text report for at most 25 targets with 5 edges each by default', async () => {
    const res = await run({ projectPath: project });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text.split('\n')[0]).toMatch(HEADER);
    expect(text).toBe(formatSuspects(findSuspects(project, { limit: 25, maxEdgesPerTarget: 5 })));
  });

  it('format json with limit 1 returns version 1 and exactly one suspect', async () => {
    const res = await run({ projectPath: project, format: 'json', limit: 1 });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.content[0].text) as SuspectsJson;
    expect(out.version).toBe(1);
    expect(out.suspects).toHaveLength(1);
  });

  it('accepts limit "all" as a string', async () => {
    const res = await run({ projectPath: project, format: 'json', limit: 'all' });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.content[0].text) as SuspectsJson;
    expect(out.suspects).toHaveLength(findSuspects(project).length);
  });

  it('accepts limit "1" as a string', async () => {
    const res = await run({ projectPath: project, format: 'json', limit: '1' });
    expect(res.isError).toBeFalsy();
    expect((JSON.parse(res.content[0].text) as SuspectsJson).suspects).toHaveLength(1);
  });

  it('maxEdgesPerTarget 0 lists no edges but keeps each edgeCount', async () => {
    const res = await run({ projectPath: project, format: 'json', maxEdgesPerTarget: 0 });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.content[0].text) as SuspectsJson;
    expect(out.suspects.length).toBeGreaterThan(0);
    for (const s of out.suspects) {
      expect(s.edges).toEqual([]);
      expect(s.edgeCount).toBeGreaterThan(0);
    }
  });

  it('resolves a projectPath inside the project to the project root', async () => {
    const res = await run({ projectPath: path.join(project, 'src') });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.split('\n')[0]).toMatch(HEADER);
  });

  it('treats null arguments as absent', async () => {
    const res = await run({ projectPath: project, limit: null, maxEdgesPerTarget: null, format: null });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe(formatSuspects(findSuspects(project, { limit: 25, maxEdgesPerTarget: 5 })));
  });

  const badArgs: Array<[string, Record<string, unknown>]> = [
    ['limit "x"', { limit: 'x' }],
    ['limit 0', { limit: 0 }],
    ['limit -1', { limit: -1 }],
    ['maxEdgesPerTarget "x"', { maxEdgesPerTarget: 'x' }],
    ['maxEdgesPerTarget -1', { maxEdgesPerTarget: -1 }],
    ['format "xml"', { format: 'xml' }],
  ];
  for (const [label, extra] of badArgs) {
    it(`answers ${label} with success-shaped guidance starting with ✗`, async () => {
      const res = await run({ projectPath: project, ...extra });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text.startsWith('✗')).toBe(true);
    });
  }

  // ToolHandler answers a non-string projectPath itself (ToolHandler's validateOptionalPath in src/mcp/tools.ts, an isError answer) before the handler runs, so the handler's own check is tested directly.
  it('handle() called directly answers a non-string projectPath with ✗ guidance and never opens a CodeGraph', async () => {
    const getCodeGraph = vi.fn((): CodeGraph => {
      throw new Error('getCodeGraph must not be called for a non-string projectPath');
    });
    const res = await suspectsTool.handle({ projectPath: 42 }, { getCodeGraph });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.startsWith('✗')).toBe(true);
    expect(getCodeGraph).not.toHaveBeenCalled();
  });

  it('answers an unindexed projectPath with success-shaped guidance, not isError', async () => {
    const res = await run({ projectPath: unindexed });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.length).toBeGreaterThan(0);
  });
});

/** Base env for one fast child: no daemon, no wasm-flag re-exec, and no extension module but what discovery finds. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEGRAPH_NO_DAEMON: '1',
    CODEGRAPH_WASM_RELAUNCHED: '1',
    CODEGRAPH_ALLOW_UNSAFE_NODE: '1',
    DO_NOT_TRACK: '1',
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

describe('codegraph suspects (built binary, zone module found by discovery)', () => {
  it('--help lists suspects', () => {
    const res = cli(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^\s+suspects\b/m);
  });

  it('suspects -p <project> prints the text report and exits 0', () => {
    const res = cli(['suspects', '-p', project]);
    expect(res.status).toBe(0);
    expect(res.stdout.split('\n')[0]).toMatch(HEADER);
    expect(res.stdout).toBe(formatSuspects(findSuspects(project, { limit: 50, maxEdgesPerTarget: 5 })) + '\n');
  });

  it('suspects with no -p uses the working directory (a subdirectory resolves to its project)', () => {
    const res = cli(['suspects'], path.join(project, 'src'));
    expect(res.status).toBe(0);
    expect(res.stdout.split('\n')[0]).toMatch(HEADER);
  });

  it('suspects --json prints { version: 1, suspects }', () => {
    const res = cli(['suspects', '--json', '-p', project]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as SuspectsJson;
    expect(out.version).toBe(1);
    expect(out.suspects).toHaveLength(findSuspects(project).length);
  });

  it('suspects --json -l 1 -e 0 prints one suspect with no listed edges', () => {
    const res = cli(['suspects', '--json', '-l', '1', '-e', '0', '-p', project]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as SuspectsJson;
    expect(out.suspects).toHaveLength(1);
    expect(out.suspects[0]!.edges).toEqual([]);
    expect(out.suspects[0]!.edgeCount).toBeGreaterThan(0);
  });

  it('suspects -l all lists every target', () => {
    const res = cli(['suspects', '--json', '-l', 'all', '-p', project]);
    expect(res.status).toBe(0);
    expect((JSON.parse(res.stdout) as SuspectsJson).suspects).toHaveLength(findSuspects(project).length);
  });

  it('suspects -p <unindexed> exits 1 with the no-index message and the path on stderr, nothing on stdout', () => {
    const res = cli(['suspects', '-p', unindexed]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('No CodeGraph index');
    expect(res.stderr).toContain(unindexed);
    expect(res.stdout).toBe('');
  });

  for (const bad of [['-l', '0'], ['-l', 'x'], ['-e', '-1'], ['-e', 'x']]) {
    it(`suspects ${bad.join(' ')} exits 1 with a ✗ message on stderr`, () => {
      const res = cli(['suspects', ...bad, '-p', project]);
      expect(res.status).toBe(1);
      expect(res.stderr.startsWith('✗')).toBe(true);
    });
  }
});

describe('CLI and MCP agree', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetExtensionsForTests();
  });

  it('CLI --json -l 1 and MCP format json limit 1 return the same first targetId', async () => {
    const res = cli(['suspects', '--json', '-l', '1', '-p', project]);
    expect(res.status).toBe(0);
    const fromCli = JSON.parse(res.stdout) as SuspectsJson;

    __resetExtensionsForTests();
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,suspects');
    registerExtension(resolutionExtension);
    const cg = await CodeGraph.open(project);
    try {
      const mcp = await new ToolHandler(cg).execute('codegraph_suspects', { projectPath: project, format: 'json', limit: 1 });
      expect(mcp.isError).toBeFalsy();
      const fromMcp = JSON.parse(mcp.content[0].text) as SuspectsJson;
      expect(fromMcp.suspects[0]!.targetId).toBe(fromCli.suspects[0]!.targetId);
    } finally {
      cg.close();
    }
  });
});
