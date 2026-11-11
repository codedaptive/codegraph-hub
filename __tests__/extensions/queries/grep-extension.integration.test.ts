/**
 * The queries extension (src/extensions/queries/extension.ts): the
 * `codegraph grep` command and the `codegraph_grep` MCP tool reach
 * grep-by-symbol through the host's extension hook.
 *
 * Built-binary tests spawn
 * dist/bin/codegraph.js with no CODEGRAPH_EXTENSION_MODULES, so the extension
 * arrives by dist discovery (dist/extensions/queries/extension.js), as it
 * ships. Vitest's global setup (__tests__/global-setup-dist.ts) rebuilds a
 * missing or stale dist before any test runs; the beforeAll checks for the
 * binary and the extension are a backstop that fail, not skip, if it is still
 * absent.
 *
 * Startup-cost tests require dist/extensions/queries/grep/grep-definition.js,
 * and separately the zone aggregate dist/extensions/queries/extension.js,
 * alone in a child `node` and assert from `require.cache` that neither loads
 * dist/index.js, anything under dist/db/, dist/resolution/ or
 * dist/extraction/, or any tree-sitter module.
 *
 * One fixture project is indexed once in beforeAll and shared, read-only.
 * This file holds the spawned-process half of grep-extension.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { formatGrepResult, grepIndex } from '../../../src/extensions/queries/grep';

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

describe("grep's registration adds nothing to startup (built modules, child node)", () => {
  const DIST = path.join(REPO, 'dist');
  // The only grep module extension.ts imports at top level; grep-command and
  // grep-mcp are imported inside the command's action and the tool's handler.
  const GREP_DEFINITION = path.join(DIST, 'extensions', 'queries', 'grep', 'grep-definition.js');
  /** Requires the module named by argv[1] with Node's own require and prints its exports and the require cache. */
  const PROBE =
    'const m = require(process.argv[1]);' +
    'process.stdout.write(JSON.stringify({ exports: Object.keys(m), cache: Object.keys(require.cache) }));';

  /** Requires `mod` alone in a child node and asserts it loaded none of the index, db, resolution, extraction or tree-sitter code. */
  function expectLightweight(mod: string, expectedExports: string[]): void {
    const res = spawnSync(process.execPath, ['-e', PROBE, mod], { encoding: 'utf-8', env: childEnv() });
    expect(res.status, res.stderr).toBe(0);
    const { exports, cache } = JSON.parse(res.stdout) as { exports: string[]; cache: string[] };
    expect(exports).toEqual(expect.arrayContaining(expectedExports));
    // Cache keys are real paths.
    const dist = fs.realpathSync(DIST);
    expect(cache).toContain(fs.realpathSync(mod));
    expect(cache).not.toContain(path.join(dist, 'index.js'));
    for (const dir of ['db', 'resolution', 'extraction']) {
      expect(cache.filter((k) => k.startsWith(path.join(dist, dir) + path.sep))).toEqual([]);
    }
    expect(cache.filter((k) => k.includes('tree-sitter'))).toEqual([]);
  }

  it('requiring grep/grep-definition.js alone loads no dist/index.js, nothing under dist/db|resolution|extraction and no tree-sitter', () => {
    expectLightweight(GREP_DEFINITION, ['GREP_TOOL']);
  });

  it('requiring the zone aggregate extension.js alone loads no dist/index.js, nothing under dist/db|resolution|extraction and no tree-sitter', () => {
    expectLightweight(DIST_EXTENSION, ['default']);
  });
});

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

/** The child's stderr, collected so a failed request can say which stage the child stopped at. */
const childStderr = new WeakMap<ChildProcessWithoutNullStreams, { text: string }>();

/** Start collecting `child`'s stderr; `request` quotes its tail when the child exits without answering. */
function captureStderr(child: ChildProcessWithoutNullStreams): void {
  const box = { text: '' };
  childStderr.set(child, box);
  child.stderr.on('data', (chunk: Buffer) => { box.text += chunk.toString(); });
}

const stderrTail = (child: ChildProcessWithoutNullStreams) => (childStderr.get(child)?.text ?? '').slice(-2000);

/**
 * Send a JSON-RPC request and resolve with the response matching its id.
 * It has no clock of its own: it waits for the answer, and rejects as soon as
 * the child exits without answering, with the exit code/signal and the tail of
 * its stderr. The calling test's vitest timeout is the only bound.
 */
function request(
  child: ChildProcessWithoutNullStreams,
  msg: { id: number; method: string; params?: unknown },
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`child exited (code ${code}, signal ${signal}) before answering id=${msg.id} (${msg.method}); stderr tail:\n${stderrTail(child)}`));
    };
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
            cleanup();
            resolve(parsed);
            return;
          }
        } catch {
          // non-JSON noise on stdout: ignore
        }
      }
    };
    // Every listener is declared above, so cleanup() is safe to call from here on.
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
      return;
    }
    child.once('exit', onExit);
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  });
}

describe('request() against a child that has already exited', () => {
  it('rejects with the exit code, the method and the stderr tail', async () => {
    const child = spawn(process.execPath, ['-e', "process.stderr.write('boom'); process.exit(3)"], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    captureStderr(child);
    // 'close' rather than 'exit': it fires once stderr has drained, so 'boom' is in the buffer.
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    expect(child.exitCode).toBe(3);
    const err = await request(child, { id: 9, method: 'initialize' }).then(
      () => { throw new Error('request() resolved against an exited child'); },
      (e: unknown) => e as Error,
    );
    expect(err).not.toBeInstanceOf(ReferenceError);
    expect(err.message).toContain('code 3');
    expect(err.message).toContain('initialize');
    expect(err.message).toContain('boom');
  });
});

describe('request() against a slow child', () => {
  it('waits past a fixed clock and resolves with the matching response', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
      }) as ChildProcessWithoutNullStreams;
      let state = 'pending';
      const response = request(child, { id: 7, method: 'tools/call' });
      response.then(
        () => { state = 'resolved'; },
        () => { state = 'rejected'; },
      );

      await vi.advanceTimersByTimeAsync(120_000);
      expect(state).toBe('pending');

      child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } }) + '\n');
      await expect(response).resolves.toMatchObject({ id: 7, result: { ok: true } });
    } finally {
      vi.useRealTimers();
    }
  });
});

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

  // The bound is generous on purpose: this spawns the built binary, whose cold
  // start alone measured 7.78 s wall (0.45 s CPU) at load 60-100. Each request()
  // waits for the answer or the child's exit, so this 600 s is the only time
  // limit on the test's outcome (afterEach's 3 s kill wait is cleanup), set so
  // a slow but working child under heavy load does not lose a race.
  it('allowlisted as grep, codegraph_grep is listed and a tools/call answers', async () => {
    child = spawn(process.execPath, [BIN, 'serve', '--mcp'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv({ CODEGRAPH_MCP_TOOLS: 'explore,grep' }),
    }) as ChildProcessWithoutNullStreams;
    captureStderr(child);

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
  }, 600_000);
});
