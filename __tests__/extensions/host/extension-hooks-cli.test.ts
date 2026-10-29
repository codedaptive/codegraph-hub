/**
 * Extension hook, built binary: the CLI command and the MCP session's
 * tools/call path, both against dist/bin/codegraph.js with
 * CODEGRAPH_EXTENSION_MODULES pointing at the fixture.
 *
 * This file imports nothing from src/extensions/host, so it tests the built
 * binary's behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';

const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');
const FIXTURE = path.resolve(__dirname, 'fixtures/test-extension.cjs');
const THROWS_NULL_PROTO_FIXTURE = path.resolve(__dirname, 'fixtures/throws-null-proto-extension.cjs');

/** Base env for a single fast child: no daemon, no wasm-flag re-exec (see cli-version.test.ts). */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEGRAPH_NO_DAEMON: '1',
    CODEGRAPH_WASM_RELAUNCHED: '1',
    ...extra,
  };
  if (!('CODEGRAPH_EXTENSION_MODULES' in extra)) delete env.CODEGRAPH_EXTENSION_MODULES;
  if (!('CODEGRAPH_MCP_TOOLS' in extra)) delete env.CODEGRAPH_MCP_TOOLS;
  return env;
}

function runCli(args: string[], extra: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf-8',
    env: childEnv(extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('extension hook: CLI commands', () => {
  it('--help lists the extension command when the fixture is loaded', () => {
    const out = runCli(['--help'], { CODEGRAPH_EXTENSION_MODULES: FIXTURE });
    expect(out).toContain('ext-hello');
    expect(out).toContain('Extension hook test command');
  });

  it('--help lists no extension command without the env', () => {
    const out = runCli(['--help']);
    expect(out).not.toContain('ext-hello');
    expect(out).not.toContain('Extension hook test command');
  });

  // EH-01: a module that throws a value String() cannot convert must not crash the CLI.
  it('--help still lists the extension command, and exits 0, after a module that throws an unprintable value', () => {
    const res = spawnSync(process.execPath, [BIN, '--help'], {
      encoding: 'utf-8',
      env: childEnv({ CODEGRAPH_EXTENSION_MODULES: `${THROWS_NULL_PROTO_FIXTURE},${FIXTURE}` }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ext-hello');
    expect(res.stderr).toContain(`[CodeGraph] extension ${THROWS_NULL_PROTO_FIXTURE} skipped: it threw a value that cannot be printed`);
    expect(res.stderr).not.toContain('Uncaught exception');
  });

  it('`codegraph ext-hello` runs the extension command and exits 0', () => {
    // execFileSync throws on a non-zero exit, so returning at all proves exit 0.
    const out = runCli(['ext-hello'], { CODEGRAPH_EXTENSION_MODULES: FIXTURE });
    expect(out).toContain('ext-hello ran');
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

describe('extension hook: MCP session tools/call', () => {
  let tempDir: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ext-session-')));
  });

  afterEach(async () => {
    if (child) {
      // Await the exit before removing the cwd (Windows holds the handles briefly).
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      child = null;
    }
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('a session tools/call for an extension tool reaches execute (no `Unknown tool`)', async () => {
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export function hello() { return 42; }\n');
    const cg = await CodeGraph.init(tempDir, { index: true });
    const fileCount = cg.getStats().fileCount;
    cg.close();

    child = spawn(process.execPath, [BIN, 'serve', '--mcp'], {
      cwd: tempDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv({ CODEGRAPH_EXTENSION_MODULES: FIXTURE, CODEGRAPH_MCP_TOOLS: 'explore,ext_echo' }),
    }) as ChildProcessWithoutNullStreams;

    await request(child, {
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
        rootUri: `file://${tempDir}`,
      },
    });

    const res = await request(child, {
      id: 2,
      method: 'tools/call',
      params: { name: 'codegraph_ext_echo', arguments: { text: 'hi', projectPath: tempDir } },
    });
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain(`ext_echo:hi:${fileCount}`);

    // The same session lists it too (allowlisted, so exempt from the tiny-repo gate).
    const listed = await request(child, { id: 1, method: 'tools/list' });
    const toolNames = ((listed.result as { tools: Array<{ name: string }> }).tools).map(t => t.name);
    expect(toolNames).toContain('codegraph_ext_echo');
  });
});
