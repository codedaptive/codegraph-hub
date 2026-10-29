/**
 * The queries extension (src/extensions/queries/extension.ts): the
 * `codegraph grep` command and the `codegraph_grep` MCP tool reach
 * grep-by-symbol through the host's extension hook.
 *
 * In-process tests register the extension from src. Built-binary tests spawn
 * dist/bin/codegraph.js with no CODEGRAPH_EXTENSION_MODULES, so the extension
 * arrives by dist discovery (dist/extensions/queries/extension.js), as it
 * ships. Vitest's global setup (__tests__/global-setup-dist.ts) rebuilds a
 * missing or stale dist before any test runs; the beforeAll checks for the
 * binary and the extension are a backstop that fail, not skip, if it is still
 * absent.
 *
 * One fixture project is indexed once in beforeAll and shared, read-only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { CodeGraph } from '../../../src';
import { NotIndexedError, PathRefusalError, ToolHandler } from '../../../src/mcp/tools';
import {
  __resetExtensionsForTests,
  extensionTools,
  findExtensionTool,
  registerExtension,
  registerExtensionCommands,
} from '../../../src/extensions/host/registry';
import queriesExtension from '../../../src/extensions/queries/extension';
import { GREP_TOOL, formatGrepResult, grepIndex, zeroHitNote } from '../../../src/extensions/queries/grep';

const REPO = path.resolve(__dirname, '../../..');
const BIN = path.join(REPO, 'dist/bin/codegraph.js');
const DIST_EXTENSION = path.join(REPO, 'dist/extensions/queries/extension.js');

const FILES: Record<string, string> = {
  'src/app.ts': [
    'export function hello(): string {',
    '  return "TOKEN in hello -dash";',
    '}',
    '',
    'export function caller(): string {',
    '  return hello();',
    '}',
    '',
  ].join('\n'),
  'lib/other.ts': ['export const other = "TOKEN at module level";', ''].join('\n'),
};

let root: string;
let cg: CodeGraph;
/** A directory with no index anywhere above it. */
let unindexed: string;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-grep-ext-')));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
  unindexed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-grep-ext-none-')));
});

afterAll(() => {
  cg?.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.rmSync(unindexed, { recursive: true, force: true });
});

describe('queries extension, in process', () => {
  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', '');
    __resetExtensionsForTests();
    registerExtension(queriesExtension);
  });

  afterEach(() => {
    __resetExtensionsForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('registers codegraph_grep with the frozen GREP_TOOL definition', () => {
    expect(queriesExtension.name).toBe('queries');
    expect(extensionTools().map(t => t.definition.name)).toContain('codegraph_grep');
    const tool = findExtensionTool('codegraph_grep');
    expect(tool).toBeDefined();
    expect(tool!.definition).toEqual(GREP_TOOL);
    expect(Object.isFrozen(tool!.definition)).toBe(true);
  });

  it('handle resolves the project through ctx.getCodeGraph and answers with the grep text', async () => {
    const asked: Array<string | undefined> = [];
    const ctx = { getCodeGraph: (p?: string) => { asked.push(p); return cg; } };
    const res = await findExtensionTool('codegraph_grep')!.handle({ pattern: 'TOKEN', projectPath: path.join(root, 'src') }, ctx);
    expect(asked).toEqual([path.join(root, 'src')]);
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([{ type: 'text', text: formatGrepResult(await grepIndex(root, 'TOKEN')) }]);
  });

  it('handle with no projectPath uses the session default from ctx.getCodeGraph()', async () => {
    const asked: Array<string | undefined> = [];
    const ctx = { getCodeGraph: (p?: string) => { asked.push(p); return cg; } };
    const res = await findExtensionTool('codegraph_grep')!.handle({ pattern: 'TOKEN', in: 'lib' }, ctx);
    expect(asked).toEqual([undefined]);
    expect(res.content[0]!.text).toBe(formatGrepResult(await grepIndex(root, 'TOKEN', { in: 'lib' })));
  });

  it('ToolHandler.execute serves codegraph_grep on the main thread', async () => {
    const res = await new ToolHandler(cg).execute('codegraph_grep', { pattern: 'TOKEN' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toBe(formatGrepResult(await grepIndex(root, 'TOKEN')));
  });

  it('handle lets ctx.getCodeGraph\'s NotIndexedError through, and ToolHandler answers it success-shaped', async () => {
    const thrown = new NotIndexedError('not indexed here');
    const ctx = { getCodeGraph: (): CodeGraph => { throw thrown; } };
    await expect(findExtensionTool('codegraph_grep')!.handle({ pattern: 'TOKEN', projectPath: unindexed }, ctx)).rejects.toBe(thrown);

    const res = await new ToolHandler(cg).execute('codegraph_grep', { pattern: 'TOKEN', projectPath: unindexed });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("isn't indexed with codegraph");
  });

  it('handle lets ctx.getCodeGraph\'s PathRefusalError through', async () => {
    const thrown = new PathRefusalError('Refusing to operate on sensitive directory: test');
    const ctx = { getCodeGraph: (): CodeGraph => { throw thrown; } };
    await expect(findExtensionTool('codegraph_grep')!.handle({ pattern: 'TOKEN', projectPath: unindexed }, ctx)).rejects.toBe(thrown);
  });

  it('ToolHandler.execute refuses codegraph_grep on a projectPath under a sensitive folder with isError', async () => {
    // The shipping entry. ToolHandler.execute resolves projectPath itself before
    // it dispatches to the extension, so this refusal comes from that resolve and
    // holds even if handle() swallowed ctx errors; the handle-level test above
    // is the one that pins handle() letting a PathRefusalError through.
    // HOME is the test sandbox's (setup-home-sandbox.ts), so this ~/.ssh is a throwaway.
    const ssh = path.join(os.homedir(), '.ssh', 'cg-grep-ext-proj');
    fs.mkdirSync(ssh, { recursive: true });
    try {
      const res = await new ToolHandler(cg).execute('codegraph_grep', { pattern: 'TOKEN', projectPath: ssh });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('Refusing to operate on sensitive directory');
    } finally {
      fs.rmSync(ssh, { recursive: true, force: true });
    }
  });

  it('the pattern property carries maxLength 4096, in the source and the registered definition', () => {
    const pattern = (GREP_TOOL.inputSchema.properties.pattern as { maxLength?: number });
    expect(pattern.maxLength).toBe(4096);
    const registered = findExtensionTool('codegraph_grep')!.definition.inputSchema as { properties: Record<string, { maxLength?: number }> };
    expect(registered.properties.pattern!.maxLength).toBe(4096);
  });

  it('ToolHandler.execute refuses a 4,097-character pattern and passes a 4,096-character one to the search', async () => {
    const handler = new ToolHandler(cg);
    const over = await handler.execute('codegraph_grep', { pattern: 'q'.repeat(4097) });
    expect(over.isError).toBe(true);
    expect(over.content[0]!.text).toBe('Error: pattern exceeds maximum length of 4096 characters (got 4097)');

    const at = await handler.execute('codegraph_grep', { pattern: 'q'.repeat(4096) });
    expect(at.isError).toBeFalsy();
    expect(at.content[0]!.text).not.toContain('exceeds maximum length');
    // No file holds 4,096 q's: the search ran and answered with the zero-hit note.
    expect(at.content[0]!.text).toBe(zeroHitNote(await grepIndex(root, 'q'.repeat(4096))));
  });

  /** Runs `codegraph <argv>` against a fresh program carrying the extension's commands. */
  async function runCommand(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
    const program = new Command().name('codegraph').exitOverride();
    registerExtensionCommands(program);
    let stdout = '';
    let stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { stdout += String(c); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { stderr += String(c); return true; });
    await program.parseAsync(argv, { from: 'user' });
    const exitCode = process.exitCode === undefined ? undefined : Number(process.exitCode);
    vi.restoreAllMocks();
    return { stdout, stderr, exitCode };
  }

  it('the grep command passes options and pattern through to the search', async () => {
    const out = await runCommand(['grep', '-i', '--in', 'src', 'token', '-p', root]);
    expect(out.stderr).toBe('');
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(formatGrepResult(await grepIndex(root, 'token', { in: 'src', ignoreCase: true })));
  });

  it('a pattern beginning with "-" reaches the search when given after --', async () => {
    const out = await runCommand(['grep', '--fixed', '-p', root, '--', '-dash']);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('"-dash"');
    expect(out.stdout).toContain('hello · function · src/app.ts');
  });
});

/** Base env for a single fast child, with no extension module or tool allowlist inherited. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' };
  delete env.CODEGRAPH_EXTENSION_MODULES;
  delete env.CODEGRAPH_MCP_TOOLS;
  return { ...env, ...extra };
}

function runCli(args: string[], cwd = REPO): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf-8', env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status };
}

describe('queries extension, built binary (dist discovery)', () => {
  beforeAll(() => {
    for (const f of [BIN, DIST_EXTENSION]) {
      if (!fs.existsSync(f)) throw new Error(`${f} is missing: build dist with \`npx tsc -p .\` before running this file`);
    }
  });

  it('--help lists the grep command', () => {
    const out = runCli(['--help']);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/^\s+grep \[options\] <pattern>/m);
  });

  it('`grep TOKEN --path <project>` prints the grouped result and exits 0', async () => {
    const out = runCli(['grep', 'TOKEN', '--path', root]);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(formatGrepResult(await grepIndex(root, 'TOKEN')));
    expect(out.stdout.startsWith('"TOKEN" — 2 hits')).toBe(true);
  });

  it('`grep --json` prints the structured result', async () => {
    const out = runCli(['grep', '--json', 'TOKEN'], path.join(root, 'src'));
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(parsed).toEqual(JSON.parse(JSON.stringify(await grepIndex(root, 'TOKEN'))));
    expect(Object.keys(parsed)).toEqual(expect.arrayContaining(['pattern', 'filesSearched', 'totalHits', 'groups']));
  });

  it('an invalid regex exits 1 with ✗ invalid pattern', () => {
    const out = runCli(['grep', '(', '--path', root]);
    expect(out.status).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('✗ invalid pattern "("');
  });
});

/** Send a JSON-RPC request and resolve with the response matching its id. */
function request(
  child: ChildProcessWithoutNullStreams,
  msg: { id: number; method: string; params?: unknown },
  timeoutMs = 15000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error(`timeout waiting for response id=${msg.id}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.id === msg.id) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolve(parsed);
            return;
          }
        } catch {
          // non-JSON noise on stdout: ignore
        }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  });
}

describe('queries extension, built binary MCP session', () => {
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeAll(() => {
    if (!fs.existsSync(DIST_EXTENSION)) throw new Error(`${DIST_EXTENSION} is missing: build dist with \`npx tsc -p .\` first`);
  });

  afterEach(async () => {
    if (child) {
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      child = null;
    }
  });

  it('allowlisted as grep, codegraph_grep is listed and a tools/call answers', async () => {
    child = spawn(process.execPath, [BIN, 'serve', '--mcp'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv({ CODEGRAPH_MCP_TOOLS: 'explore,grep' }),
    }) as ChildProcessWithoutNullStreams;

    await request(child, {
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
        rootUri: `file://${root}`,
      },
    });

    const listed = await request(child, { id: 1, method: 'tools/list' });
    const toolNames = (listed.result as { tools: Array<{ name: string }> }).tools.map(t => t.name);
    expect(toolNames).toContain('codegraph_grep');

    const res = await request(child, {
      id: 2,
      method: 'tools/call',
      params: { name: 'codegraph_grep', arguments: { pattern: 'TOKEN', projectPath: root } },
    });
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe(formatGrepResult(await grepIndex(root, 'TOKEN')));
  });
});
