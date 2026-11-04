/**
 * Session policy tests for a launch directory with no index of its own (#964).
 *
 * The server has no default project, so a launch directory that is (or is not)
 * indexed changes nothing about the session: `initialize` returns the one
 * instructions text (never an "inactive" note), `tools/list` exposes the tool
 * surface, and a query against an indexed project by `projectPath` works.
 * Safety is preserved by the response SHAPE, not by hiding tools: a call
 * against an un-indexed path, or without a `projectPath`, returns
 * SUCCESS-shaped guidance, never `isError: true` — one or two early isError
 * responses teach an agent to abandon codegraph for the whole session, and
 * that failure mode is still guarded below.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { MISSING_PROJECT_PATH_TEXT } from '../src/extensions/host/server/repo-anchor';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function spawnServer(cwd: string, stateDir: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Direct (in-process) mode keeps the suite from leaking a detached machine
    // server. CODEGRAPH_STATE_DIR keeps the project registry (and anything else
    // the server writes) out of the real ~/.codegraph.
    // CODEGRAPH_WASM_RELAUNCHED skips the --liftoff-only re-exec: without
    // it the server runs as a GRANDCHILD that survives child.kill() on
    // Windows and holds the temp cwd/SQLite handles, failing teardown with
    // EPERM no matter how long rmSync retries (the class documented for
    // the mcp-initialize/mcp-roots suites).
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', CODEGRAPH_STATE_DIR: stateDir },
  }) as ChildProcessWithoutNullStreams;
}

/** Send a JSON-RPC request and resolve with the response matching its id. */
function request(
  child: ChildProcessWithoutNullStreams,
  msg: { id: number; method: string; params?: unknown },
  timeoutMs = 15000
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
          // non-JSON noise on stdout — ignore
        }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  });
}

function initializeParams(projectPath: string) {
  return {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
    rootUri: `file://${projectPath}`,
  };
}

describe('Session policy for a launch directory with no index', () => {
  let tempDir: string;
  let stateDir: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-unindexed-'));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-unindexed-state-'));
  });

  afterEach(async () => {
    if (child) {
      // Wait for the child to actually exit before removing its cwd — on
      // Windows a just-killed process briefly holds the directory/SQLite
      // handles, and an immediate rmSync fails the teardown with EPERM
      // (the documented file-locking class that fails the sibling
      // mcp-initialize/mcp-roots suites). kill + await exit + retried
      // removal keeps this suite green on Windows.
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      child = null;
    }
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('initialize returns the one instructions text (not "inactive"), naming projectPath and the missing-argument answer', async () => {
    fs.writeFileSync(path.join(tempDir, 'index.ts'), 'export const x = 1;\n');
    child = spawnServer(tempDir, stateDir);

    const res = await request(child, { id: 0, method: 'initialize', params: initializeParams(tempDir) });
    const instructions = (res.result as { instructions: string }).instructions;

    // Not an "inactive, do nothing" note — the tools are available.
    expect(instructions).not.toMatch(/inactive/i);
    // It tells the agent every call needs projectPath, and what a call without one is answered...
    expect(instructions).toMatch(/projectPath/);
    expect(instructions).toContain(MISSING_PROJECT_PATH_TEXT);
    expect(instructions).toMatch(/codegraph_explore/);
    expect(instructions).toMatch(/codegraph init/);
    // ...and it is the full playbook, whether or not the launch directory is indexed.
    expect(instructions).toMatch(/## How to query/);
  });

  it('tools/list exposes the tools even when the launch directory has no index (#964)', async () => {
    child = spawnServer(tempDir, stateDir);
    await request(child, { id: 0, method: 'initialize', params: initializeParams(tempDir) });

    const res = await request(child, { id: 1, method: 'tools/list' });
    const tools = (res.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.map((t) => t.name)).toContain('codegraph_explore');
  });

  it('a query by projectPath reaches an INDEXED sub-project of an unindexed launch directory (monorepo) (#964)', async () => {
    // The launch directory (tempDir) has no index; an indexed sub-project lives
    // under it — exactly the monorepo shape (outside a repository, the anchor
    // is the launch directory and its subtree). The query must resolve to the
    // sub-project's .codegraph/ and return real results. Run through the real
    // spawned server (a second-project open can't be exercised in-process under
    // vitest — see mcp-toolhandler cache notes — but a child process can).
    const svc = path.join(tempDir, 'service_a');
    fs.mkdirSync(svc);
    fs.writeFileSync(
      path.join(svc, 'auth.ts'),
      'export function validateToken(t: string): boolean { return !!t; }\n'
    );
    const cg = await CodeGraph.init(svc, { index: true });
    cg.close();

    child = spawnServer(tempDir, stateDir);
    await request(child, { id: 0, method: 'initialize', params: initializeParams(tempDir) });

    const res = await request(child, {
      id: 1,
      method: 'tools/call',
      params: { name: 'codegraph_search', arguments: { query: 'validateToken', projectPath: svc } },
    });
    const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/validateToken/);
    expect(result.content[0]!.text).not.toMatch(/isn't indexed/);
  });

  it('a call without projectPath is answered exactly the missing-argument text, even in an INDEXED launch directory', async () => {
    fs.writeFileSync(path.join(tempDir, 'index.ts'), 'export function hello(): string { return "hi"; }\n');
    const cg = await CodeGraph.init(tempDir, { index: true });
    cg.close();

    child = spawnServer(tempDir, stateDir);
    const init = await request(child, { id: 0, method: 'initialize', params: initializeParams(tempDir) });
    const instructions = (init.result as { instructions: string }).instructions;
    expect(instructions).toMatch(/How to query/);
    expect(instructions).not.toMatch(/inactive/i);

    // No fallback to the launch directory's own index: no projectPath, no answer from a default.
    const bare = await request(child, {
      id: 2,
      method: 'tools/call',
      params: { name: 'codegraph_explore', arguments: { query: 'hello' } },
    });
    const bareResult = bare.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(bareResult.isError).toBeFalsy();
    expect(bareResult.content[0]!.text).toBe(MISSING_PROJECT_PATH_TEXT);

    // With the path it answers from that index.
    const named = await request(child, {
      id: 3,
      method: 'tools/call',
      params: { name: 'codegraph_explore', arguments: { query: 'hello', projectPath: tempDir } },
    });
    const namedResult = named.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(namedResult.isError).toBeFalsy();
    expect(namedResult.content[0]!.text).toMatch(/hello/);

    const list = await request(child, { id: 1, method: 'tools/list' });
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    // The default surface is pared to explore alone (see DEFAULT_MCP_TOOLS) — the
    // contract under test is "indexed → tools are PRESENT", in contrast to the
    // unindexed empty list above.
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.map((t) => t.name)).toContain('codegraph_explore');
  });
});

describe('No-error policy on expected conditions', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noerror-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('cross-project query to an unindexed path is SUCCESS-shaped guidance, not isError', async () => {
    const res = await new ToolHandler(null).execute('codegraph_search', {
      query: 'anything',
      projectPath: tempDir,
    });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/isn't indexed/);
    expect(res.content[0]!.text).toMatch(/codegraph init/);
    expect(res.content[0]!.text).toMatch(/built-in tools/);
  });

  it('a handler with no default project answers a call without projectPath with the missing-argument text, SUCCESS-shaped', async () => {
    const res = await new ToolHandler(null).execute('codegraph_search', { query: 'anything' });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toBe(MISSING_PROJECT_PATH_TEXT);
  });


  it.runIf(process.platform !== 'win32')(
    'sensitive-path refusal stays a hard error (no retry encouragement)',
    async () => {
      const res = await new ToolHandler(null).execute('codegraph_search', {
        query: 'anything',
        projectPath: '/etc',
      });

      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).not.toMatch(/retry the call once/);
    }
  );
});

describe('search kind filter', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-kind-'));
    fs.writeFileSync(
      path.join(tempDir, 'types.ts'),
      'export type PaymentMethod = { id: string };\nexport function pay(): void {}\n'
    );
    cg = await CodeGraph.init(tempDir, { index: true });
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("kind: 'type' (the advertised enum value) finds type aliases", async () => {
    const res = await new ToolHandler(cg).execute('codegraph_search', {
      query: 'PaymentMethod',
      kind: 'type',
    });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/PaymentMethod/);
    expect(res.content[0]!.text).not.toMatch(/No results found/);
  });
});
