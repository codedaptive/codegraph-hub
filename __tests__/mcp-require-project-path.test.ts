/**
 * projectPath is `required` in the tool schema (issue #993).
 *
 * The MCP server has no default project to fall back to, so every tool call
 * MUST carry an explicit `projectPath`. `ToolHandler.getTools()` reflects that
 * by marking `projectPath` required in the exposed schemas, a high-salience
 * nudge that gets the agent to pass it on the first call instead of omitting it
 * (the reported behavior). It does so whether or not the handler holds a
 * CodeGraph of its own (only the CLI's handler does).
 *
 * The runtime backstop is success-shaped: a missing projectPath on a handler
 * with no default returns the missing-argument text (never `isError`), while the
 * CLI's handler, which has a default CodeGraph, still falls back to it.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolHandler, tools } from '../src/mcp/tools';
import { CodeGraph } from '../src';

const ENV = 'CODEGRAPH_MCP_TOOLS';

const exploreOf = (defs: { name: string; inputSchema: { required?: string[] } }[]) =>
  defs.find((t) => t.name === 'codegraph_explore')!;

describe('A handler with no default project requires projectPath in the schema (#993)', () => {
  const originalAllowlist = process.env[ENV];
  afterEach(() => {
    if (originalAllowlist === undefined) delete process.env[ENV];
    else process.env[ENV] = originalAllowlist;
  });

  it('marks projectPath required on codegraph_explore', () => {
    const explore = exploreOf(new ToolHandler(null).getTools());
    expect(explore.inputSchema.required).toContain('projectPath');
    // The tool's own required arg is preserved, not replaced.
    expect(explore.inputSchema.required).toContain('query');
  });

  it('requires projectPath on EVERY exposed tool, incl. ones with no prior required list', () => {
    // status has no `required` array of its own → it should gain ['projectPath'].
    process.env[ENV] = 'explore,node,status';
    const got = new ToolHandler(null).getTools();
    expect(got.map((t) => t.name).sort()).toEqual([
      'codegraph_explore',
      'codegraph_node',
      'codegraph_status',
    ]);
    for (const t of got) {
      expect(t.inputSchema.required ?? []).toContain('projectPath');
    }
  });

  it('does NOT mutate the shared module-level tools array (purity)', () => {
    // Marking required must clone — otherwise one session's listing would
    // corrupt the schema every later caller (the CLI) reuses.
    new ToolHandler(null).getTools();
    expect(exploreOf(tools).inputSchema.required).toEqual(['query']);
  });

  it('a missing projectPath with no default is SUCCESS-shaped guidance, not isError', async () => {
    // A client that ignores `required` still gets the exact missing-argument
    // answer, never a session-souring isError.
    const res = await new ToolHandler(null).execute('codegraph_explore', { query: 'anything' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toBe('missing argument: root path to the code you wish to query');
  });
});

describe('The CLI handler (it has a default CodeGraph) lists projectPath required but still falls back to it (#993)', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-reqpath-'));
    fs.writeFileSync(
      path.join(tempDir, 'pay.ts'),
      'export function processPayment(amount: number): boolean { return amount > 0; }\n'
    );
    cg = await CodeGraph.init(tempDir, { index: true });
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('marks projectPath required even when the handler has a default CodeGraph', () => {
    const explore = exploreOf(new ToolHandler(cg).getTools());
    expect(explore.inputSchema.required).toEqual(['query', 'projectPath']);
  });

  it('a bare call (no projectPath) on the CLI handler still falls back to its default CodeGraph', async () => {
    const res = await new ToolHandler(cg).execute('codegraph_explore', { query: 'processPayment' });
    expect(res.isError).toBeUndefined();
    // Resolved against the default CodeGraph — not the missing-argument answer.
    expect(res.content[0]!.text).not.toMatch(/missing argument/);
    expect(res.content[0]!.text).toMatch(/processPayment/);
  });
});
