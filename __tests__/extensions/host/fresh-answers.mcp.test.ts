/**
 * Fresh answers over MCP: the `fresh` and `checkpoint` tool arguments.
 *
 * - `fresh: true` makes ToolHandler.execute wait (bounded by
 *   CODEGRAPH_FRESH_TIMEOUT_MS) until the index matches the working tree, then
 *   answer, and append a `Checkpoint:` footer line.
 * - `checkpoint: true` appends the footer without waiting.
 * - Every tool schema carries both as optional booleans; `required` is untouched.
 *
 * The footer's head is checked against `git rev-parse HEAD` run here, in a temp
 * git repo built per test. The CodeGraph is writable (initSync + indexAll) and
 * no watcher is started: the edit stays pending until a sync is asked for, so
 * "without fresh the edit is not seen" is deterministic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import CodeGraph from '../../../src/index';
import { ToolHandler, tools } from '../../../src/mcp/tools';

const TIMEOUT_ENV = 'CODEGRAPH_FRESH_TIMEOUT_MS';
const TOOLS_ENV = 'CODEGRAPH_MCP_TOOLS';

const CHECKPOINT_LINE =
  /^Checkpoint: head=(\S+) dirty=(\S+) pending=(\S+) fresh=(yes|no)$/;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

interface Footer {
  head: string;
  dirty: string;
  pending: string;
  fresh: 'yes' | 'no';
  /** The lines after the Checkpoint line (only a `Note:` line is allowed there). */
  after: string[];
}

/** The last `Checkpoint:` line of a response and what follows it, or null. */
function footerOf(text: string): Footer | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = CHECKPOINT_LINE.exec(lines[i]!);
    if (m) {
      return {
        head: m[1]!,
        dirty: m[2]!,
        pending: m[3]!,
        fresh: m[4] as 'yes' | 'no',
        after: lines.slice(i + 1).filter((l) => l.trim() !== ''),
      };
    }
  }
  return null;
}

/** codegraph_search found the symbol: a hit names its file, a miss says "No results found". */
function sawEdit(text: string): boolean {
  return /a\.ts/.test(text) && !/No results found/.test(text);
}

describe('fresh-answers over MCP (M1-M3)', () => {
  let repo: string;
  let cg: CodeGraph;
  let handler: ToolHandler;
  const savedTimeout = process.env[TIMEOUT_ENV];

  beforeEach(async () => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fresh-mcp-')));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Fresh Answers Test');
    git(repo, 'config', 'user.email', 'fresh@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export function alpha() { return 1; }\n');
    fs.writeFileSync(path.join(repo, 'c.ts'), 'export function gamma() { return 3; }\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), '.codegraph/\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');

    cg = CodeGraph.initSync(repo);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (savedTimeout === undefined) delete process.env[TIMEOUT_ENV];
    else process.env[TIMEOUT_ENV] = savedTimeout;
    try { cg.close(); } catch { /* ignore */ }
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const editA = () =>
    fs.appendFileSync(path.join(repo, 'a.ts'), 'export function freshlyAdded() {}\n');

  // Over 5 s on a loaded machine (2.1 s alone): a temp git repo, an indexAll, and a sync of the pending edit.
  it('M1: fresh:true syncs the pending edit before answering and reports head and fresh=yes', async () => {
    editA();

    const stale = await handler.execute('codegraph_search', { query: 'freshlyAdded' });
    expect(sawEdit(stale.content[0]!.text)).toBe(false);

    const res = await handler.execute('codegraph_search', { query: 'freshlyAdded', fresh: true });
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    expect(sawEdit(text)).toBe(true);

    const footer = footerOf(text);
    expect(footer, `no Checkpoint line in:\n${text}`).not.toBeNull();
    // Fresh: the Checkpoint line is the very last line, with no Note after it.
    expect(footer!.after).toEqual([]);
    expect(footer!.head).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(footer!.pending).toBe('0');
    expect(footer!.fresh).toBe('yes');
  });

  it('M2: checkpoint:true reports pending=1 fresh=no without waiting or syncing', async () => {
    editA();

    const res = await handler.execute('codegraph_search', { query: 'freshlyAdded', checkpoint: true });
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    expect(sawEdit(text)).toBe(false);

    const footer = footerOf(text);
    expect(footer, `no Checkpoint line in:\n${text}`).not.toBeNull();
    expect(footer!.after).toEqual([]);
    expect(text).not.toMatch(/^Note:/m);
    expect(footer!.head).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(footer!.dirty).not.toBe('none');
    expect(footer!.pending).toBe('1');
    expect(footer!.fresh).toBe('no');
  });

  it('M3: with a zero bound, fresh:true answers anyway with a Note line and fresh=no', async () => {
    process.env[TIMEOUT_ENV] = '0';
    editA();

    const res = await handler.execute('codegraph_search', { query: 'freshlyAdded', fresh: true });
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;

    const footer = footerOf(text);
    expect(footer, `no Checkpoint line in:\n${text}`).not.toBeNull();
    expect(footer!.fresh).toBe('no');
    expect(footer!.pending).toBe('1');
    // The Note line follows the Checkpoint line and closes the response.
    expect(footer!.after).toHaveLength(1);
    expect(footer!.after[0]).toMatch(/^Note:/);
  });
});

describe('fresh-answers tool schemas (M4)', () => {
  const savedAllowlist = process.env[TOOLS_ENV];
  let repo: string | null = null;
  let cg: CodeGraph | null = null;

  afterEach(() => {
    if (savedAllowlist === undefined) delete process.env[TOOLS_ENV];
    else process.env[TOOLS_ENV] = savedAllowlist;
    try { cg?.close(); } catch { /* ignore */ }
    cg = null;
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
    repo = null;
  });

  const baseRequired = new Map(tools.map((t) => [t.name, t.inputSchema.required]));
  const allNames = tools.map((t) => t.name.replace(/^codegraph_/, '')).join(',');

  type Def = { name: string; inputSchema: { properties: Record<string, { type?: string }>; required?: string[] } };

  function expectFlags(defs: Def[]): void {
    expect(defs.length).toBeGreaterThan(0);
    for (const t of defs) {
      expect(t.inputSchema.properties.fresh, `${t.name} lacks fresh`).toMatchObject({ type: 'boolean' });
      expect(t.inputSchema.properties.checkpoint, `${t.name} lacks checkpoint`).toMatchObject({ type: 'boolean' });
      expect(t.inputSchema.required ?? [], `${t.name} requires fresh/checkpoint`).not.toContain('fresh');
      expect(t.inputSchema.required ?? []).not.toContain('checkpoint');
    }
  }

  it('M4: every tool (a handler with no default CodeGraph) lists fresh and checkpoint as booleans, required gaining only projectPath', () => {
    process.env[TOOLS_ENV] = allNames;
    const defs = new ToolHandler(null).getTools() as Def[];
    expect(defs.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
    expectFlags(defs);
    // The only change to `required` is projectPath (#993).
    for (const t of defs) {
      const base = baseRequired.get(t.name) ?? [];
      const expected = base.includes('projectPath') ? base : [...base, 'projectPath'];
      expect(t.inputSchema.required, t.name).toEqual(expected);
    }
  });

  it('M4: every tool a handler with a default CodeGraph exposes lists fresh and checkpoint, required gaining only projectPath', async () => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fresh-schema-')));
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export function alpha() { return 1; }\n');
    cg = CodeGraph.initSync(repo);
    await cg.indexAll();
    process.env[TOOLS_ENV] = allNames;
    const defs = new ToolHandler(cg).getTools() as Def[];
    expectFlags(defs);
    // projectPath is required on every tool whatever the handler holds (#993).
    for (const t of defs) {
      const base = baseRequired.get(t.name) ?? [];
      const expected = base.includes('projectPath') ? base : [...base, 'projectPath'];
      expect(t.inputSchema.required, t.name).toEqual(expected);
    }
  });
});
