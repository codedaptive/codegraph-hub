/**
 * The built-binary `serve --mcp` session test for the queries extension:
 * allowlisted as grep, codegraph_grep is listed and a tools/call answers.
 *
 * It spawns dist/bin/codegraph.js and waits on three JSON-RPC answers, so its
 * result is bound to the clock of a spawned built binary under machine load.
 * A failure for load is moved, not fixed (S-67), so it runs in the validation
 * group rather than the integration group.
 *
 * The constants, the fixture (beforeAll/afterAll), childEnv, the stderr
 * capture and request() are verbatim copies of
 * grep-extension.integration.test.ts's.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
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

/** The child's stderr, collected so a failed request can say which stage the child stopped at. */
const childStderr = new WeakMap<ChildProcessWithoutNullStreams, { text: string }>();

/** Start collecting `child`'s stderr; `request` quotes its tail on a timeout or an early exit. */
function captureStderr(child: ChildProcessWithoutNullStreams): void {
  const box = { text: '' };
  childStderr.set(child, box);
  child.stderr.on('data', (chunk: Buffer) => { box.text += chunk.toString(); });
}

const stderrTail = (child: ChildProcessWithoutNullStreams) => (childStderr.get(child)?.text ?? '').slice(-2000);

/**
 * Send a JSON-RPC request and resolve with the response matching its id.
 * Rejects on timeout, or as soon as the child exits without answering, with
 * the exit code/signal and the tail of its stderr.
 */
function request(
  child: ChildProcessWithoutNullStreams,
  msg: { id: number; method: string; params?: unknown },
  timeoutMs = 15000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for response id=${msg.id} (${msg.method}); stderr tail:\n${stderrTail(child)}`));
    }, timeoutMs);
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
    // Every listener and the timer are declared above, so cleanup() is safe to call from here on.
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
      return;
    }
    child.once('exit', onExit);
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

  // Over 5 s by design: this spawns the built binary, whose cold start alone
  // measured 7.78 s wall (0.45 s CPU) at load 60-100. Three requests at
  // request()'s 15 s each, plus slack, is 60 s.
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
  }, 60_000);
});
