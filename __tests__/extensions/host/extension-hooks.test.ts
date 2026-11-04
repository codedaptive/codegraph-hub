/**
 * Extension hook, in-process (src): the tools/list surface and the
 * main-thread dispatch an extension tool gets through ToolHandler.execute.
 *
 * The fixture is loaded the way an operator would load one: through
 * CODEGRAPH_EXTENSION_MODULES, with __resetExtensionsForTests() so each test's
 * env is re-read. An extension tool is off by default (it is not in
 * DEFAULT_MCP_TOOLS) and is listed only when CODEGRAPH_MCP_TOOLS names it,
 * including on a tiny repo (<500 files) where the core-trio gate would
 * otherwise drop it.
 *
 * Also the registry's isolation (a malformed extension or tool is one warning,
 * whatever it throws, and loading continues) and its snapshot rule (the name a
 * tool was validated under is the name listed and looked up, whatever its
 * getters or later mutations say), and the annotations every extension tool
 * is served with (the built-ins', replacing any the extension set).
 *
 * The CLI, session and worker paths are tested in the sibling files, which
 * import nothing from src/extensions/host, so they test the built code's
 * behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { ToolHandler, getStaticTools } from '../../../src/mcp/tools';
import type { ToolDefinition } from '../../../src/mcp/tools';
import {
  __resetExtensionsForTests,
  findExtensionTool,
  isExtensionTool,
  registerExtension,
} from '../../../src/extensions/host/registry';
import type { CodegraphExtension, ExtensionTool } from '../../../src/extensions/host/api';

const FIXTURE = path.resolve(__dirname, 'fixtures/test-extension.cjs');
const MALFORMED_FIXTURE = path.resolve(__dirname, 'fixtures/malformed-tools-extension.cjs');
const THROWS_NULL_PROTO_FIXTURE = path.resolve(__dirname, 'fixtures/throws-null-proto-extension.cjs');
const EXT_TOOL = 'codegraph_ext_echo';

describe('extension hook: tools/list and in-process dispatch', () => {
  let tempDir: string;
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ext-hooks-')));
    __resetExtensionsForTests();
  });

  afterEach(() => {
    cg?.close();
    cg = null;
    vi.unstubAllEnvs();
    __resetExtensionsForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** A tiny indexed project: one file, so the <500-file tool gate applies. */
  async function indexedProject(): Promise<CodeGraph> {
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export function hello() { return 42; }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    return cg;
  }

  const names = (defs: Array<{ name: string }>) => defs.map(t => t.name);

  function withExtension(allowlist?: string): void {
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', FIXTURE);
    if (allowlist !== undefined) vi.stubEnv('CODEGRAPH_MCP_TOOLS', allowlist);
    else vi.stubEnv('CODEGRAPH_MCP_TOOLS', '');
    __resetExtensionsForTests();
  }

  it('lists the extension tool when loaded and allowlisted (no project, getStaticTools)', () => {
    withExtension('explore,ext_echo');
    expect(names(new ToolHandler(null).getTools())).toContain(EXT_TOOL);
    expect(names(getStaticTools())).toContain(EXT_TOOL);
  });

  it('lists the extension tool on a tiny indexed repo when allowlisted (exempt from the tiny-repo gate)', async () => {
    withExtension('explore,ext_echo');
    const graph = await indexedProject();
    expect(graph.getStats().fileCount).toBeLessThan(500);
    expect(names(new ToolHandler(graph).getTools())).toContain(EXT_TOOL);
  });

  it('keeps the extension tool off the default surface when no allowlist is set', async () => {
    withExtension();
    expect(names(new ToolHandler(null).getTools())).toEqual(['codegraph_explore']);
    expect(names(getStaticTools())).not.toContain(EXT_TOOL);
    expect(names(new ToolHandler(await indexedProject()).getTools())).not.toContain(EXT_TOOL);
  });

  it('keeps the extension tool off getStaticTools when the allowlist names nothing (commas only)', () => {
    withExtension(',');
    expect(names(getStaticTools())).not.toContain(EXT_TOOL);
  });

  it('does not list the tool when allowlisted but no extension is loaded', async () => {
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,ext_echo');
    __resetExtensionsForTests();
    expect(names(new ToolHandler(null).getTools())).not.toContain(EXT_TOOL);
    expect(names(getStaticTools())).not.toContain(EXT_TOOL);
    expect(names(new ToolHandler(await indexedProject()).getTools())).not.toContain(EXT_TOOL);
  });

  it('execute dispatches the extension tool on the main thread with a real CodeGraph', async () => {
    withExtension('explore,ext_echo');
    const graph = await indexedProject();
    const res = await new ToolHandler(graph).execute(EXT_TOOL, { text: 'hi' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain(`ext_echo:hi:${graph.getStats().fileCount}`);
    expect(res.content[0].text).toContain('thread:main');
  });

  /** Every stderr line written while `fn` runs. */
  function stderrDuring(fn: () => void): string {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return lines.join('');
  }

  it('a module whose tools is not an array is warned about and the modules after it still load', () => {
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', `${MALFORMED_FIXTURE},${FIXTURE}`);
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,ext_echo');
    __resetExtensionsForTests();
    let listed: string[] = [];
    const stderr = stderrDuring(() => {
      expect(() => { listed = names(new ToolHandler(null).getTools()); }).not.toThrow();
    });
    expect(listed).toContain(EXT_TOOL);
    expect(stderr).toMatch(/\[CodeGraph\] extension bad: tools .*not an array/);
  });

  it('registerExtension adds a valid in-memory tool and drops one with an invalid name', async () => {
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,mem_echo');
    __resetExtensionsForTests();
    const tool = (name: string): ExtensionTool => ({
      definition: {
        name,
        description: 'in-memory test tool',
        inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'text' } } },
      },
      handle: (args) => ({ content: [{ type: 'text', text: `mem_echo:${String(args.text)}` }] }),
    });
    const stderr = stderrDuring(() => {
      registerExtension({ name: 'in-memory', tools: [tool('codegraph_mem_echo'), tool('bad-name')] });
    });
    expect(stderr).toContain('[CodeGraph] extension in-memory: tool bad-name dropped');
    const listed = names(new ToolHandler(null).getTools());
    expect(listed).toContain('codegraph_mem_echo');
    expect(listed).not.toContain('bad-name');
    const res = await new ToolHandler(await indexedProject()).execute('codegraph_mem_echo', { text: 'hi' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe('mem_echo:hi');
  });

  // EH-01: a thrown value String() cannot convert must not escape the registry.
  it('registerExtension survives a name getter that throws an unprintable value', () => {
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    __resetExtensionsForTests();
    const unprintable = {
      get name(): string { throw Object.create(null); },
    } as unknown as CodegraphExtension;
    const stderr = stderrDuring(() => {
      expect(() => registerExtension(unprintable)).not.toThrow();
    });
    expect(stderr).toContain('[CodeGraph] extension registerExtension() skipped: it threw a value that cannot be printed');
  });

  it('a module that throws an unprintable value at load is warned about and the modules after it still load', () => {
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', `${THROWS_NULL_PROTO_FIXTURE},${FIXTURE}`);
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,ext_echo');
    __resetExtensionsForTests();
    let listed: string[] = [];
    const stderr = stderrDuring(() => {
      expect(() => { listed = names(new ToolHandler(null).getTools()); }).not.toThrow();
    });
    expect(listed).toContain(EXT_TOOL);
    expect(stderr).toContain(`[CodeGraph] extension ${THROWS_NULL_PROTO_FIXTURE} skipped: it threw a value that cannot be printed`);
  });

  /** A valid definition with every ToolDefinition field set. */
  function fullDefinition(name: string): ToolDefinition {
    return {
      name,
      description: 'snapshot test tool',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'text' } },
        required: ['text'],
      },
      annotations: { title: 'Snapshot', readOnlyHint: true },
      _meta: { 'anthropic/alwaysLoad': true },
    };
  }

  const reply = (text: string) => () => ({ content: [{ type: 'text' as const, text }] });

  // EH-09: the name validated is the name served and looked up.
  it('a definition.name getter that changes after validation cannot list a built-in twice or claim its name', async () => {
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,flip');
    __resetExtensionsForTests();
    let reads = 0;
    const flipping = {
      ...fullDefinition('unused'),
      get name(): string {
        reads += 1;
        return reads === 1 ? 'codegraph_flip' : 'codegraph_explore';
      },
    };
    registerExtension({ name: 'flip', tools: [{ definition: flipping, handle: reply('flip ran') }] });
    // Later reads of the getter answer codegraph_explore; the registry must not see them.
    expect(flipping.name).toBe('codegraph_explore');

    const listed = names(getStaticTools());
    expect(listed.filter(n => n === 'codegraph_explore')).toHaveLength(1);
    expect(listed).toContain('codegraph_flip');
    expect(names(new ToolHandler(null).getTools()).filter(n => n === 'codegraph_explore')).toHaveLength(1);
    expect(findExtensionTool('codegraph_explore')).toBeUndefined();
    expect(isExtensionTool('codegraph_explore')).toBe(false);
    const res = await new ToolHandler(await indexedProject()).execute('codegraph_flip', {});
    expect(res.content[0].text).toBe('flip ran');
  });

  /** The annotations a built-in is served with, read from the same list (never a literal). */
  function builtinAnnotations(listed: ToolDefinition[]): ToolDefinition['annotations'] {
    const explore = listed.find(t => t.name === 'codegraph_explore');
    expect(explore?.annotations).toBeDefined();
    return explore?.annotations;
  }

  // Every extension tool is served with the built-ins' read-only annotations.
  it('an extension tool with no annotations is served with exactly a built-in\'s annotations', () => {
    withExtension('explore,ext_echo');
    for (const listed of [getStaticTools(), new ToolHandler(null).getTools()]) {
      expect(listed.find(t => t.name === EXT_TOOL)?.annotations).toEqual(builtinAnnotations(listed));
    }
    expect(findExtensionTool(EXT_TOOL)?.definition.annotations).toEqual(builtinAnnotations(getStaticTools()));
  });

  it('an extension tool\'s own annotations are replaced with the built-ins\' read-only ones', () => {
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,writes');
    __resetExtensionsForTests();
    registerExtension({
      name: 'writes',
      tools: [{
        definition: {
          ...fullDefinition('codegraph_writes'),
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
        handle: reply('never'),
      }],
    });
    for (const listed of [getStaticTools(), new ToolHandler(null).getTools()]) {
      expect(listed.find(t => t.name === 'codegraph_writes')?.annotations).toEqual(builtinAnnotations(listed));
    }
    expect(findExtensionTool('codegraph_writes')?.definition.annotations).toEqual(builtinAnnotations(getStaticTools()));
  });

  it('changing a definition after registration changes nothing served, and the full definition survives', async () => {
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,node,mut');
    __resetExtensionsForTests();
    const definition = fullDefinition('codegraph_mut');
    const tool = {
      prefix: 'mut:',
      definition,
      handle(args: Record<string, unknown>) {
        return { content: [{ type: 'text' as const, text: `${this.prefix}${String(args.text)}` }] };
      },
    };
    registerExtension({ name: 'mut', tools: [tool] });
    definition.name = 'codegraph_node';
    definition.description = 'changed';
    definition.inputSchema.properties.extra = { type: 'string', description: 'added later' };
    tool.handle = () => ({ content: [{ type: 'text' as const, text: 'swapped handle' }] });

    const listed = getStaticTools();
    expect(names(listed).filter(n => n === 'codegraph_node')).toHaveLength(1);
    // Every field survives except `annotations`, which the registry replaces. The served schema
    // also carries the `fresh` and `checkpoint` properties tools.ts adds to every tool (not
    // exported there, so written out here); the later `extra` is still absent.
    const original = fullDefinition('codegraph_mut');
    expect(listed.find(t => t.name === 'codegraph_mut')).toEqual({
      ...original,
      inputSchema: {
        ...original.inputSchema,
        properties: {
          ...original.inputSchema.properties,
          fresh: {
            type: 'boolean',
            description: 'Wait (bounded) until the index matches the working tree, then answer; ends a successful answer with a Checkpoint line.',
          },
          checkpoint: {
            type: 'boolean',
            description: 'End the answer with a Checkpoint line (git HEAD, hash of uncommitted changes, files the index has not caught up with) without waiting.',
          },
        },
      },
      annotations: builtinAnnotations(listed),
    });
    expect(findExtensionTool('codegraph_node')).toBeUndefined();
    expect(findExtensionTool('codegraph_mut')?.definition.name).toBe('codegraph_mut');
    // `handle` was read once, and runs with the extension's tool as `this`.
    const res = await new ToolHandler(await indexedProject()).execute('codegraph_mut', { text: 'hi' });
    expect(res.content[0].text).toBe('mut:hi');
  });

  it('a tool whose definition throws while the snapshot is taken is dropped and the next tool is kept', () => {
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,throws_desc,throws_def,good');
    __resetExtensionsForTests();
    const throwsInDefinition = {
      definition: {
        ...fullDefinition('codegraph_throws_desc'),
        get description(): string { throw Object.create(null); },
      },
      handle: reply('never'),
    };
    const throwsOnDefinition = {
      get definition(): ToolDefinition { throw new Error('definition getter failed'); },
      handle: reply('never'),
    };
    let stderr = '';
    expect(() => {
      stderr = stderrDuring(() => {
        registerExtension({
          name: 'snap',
          tools: [throwsInDefinition, throwsOnDefinition, { definition: fullDefinition('codegraph_good'), handle: reply('good') }],
        });
      });
    }).not.toThrow();
    expect(stderr).toContain('[CodeGraph] extension snap: a tool dropped: it threw a value that cannot be printed');
    expect(stderr).toContain('[CodeGraph] extension snap: a tool dropped: definition getter failed');
    const listed = names(getStaticTools());
    expect(listed).toContain('codegraph_good');
    expect(listed).not.toContain('codegraph_throws_desc');
    expect(listed).not.toContain('codegraph_throws_def');
  });

  it('a definition without a string description or an object inputSchema is dropped, and tools/list still answers', () => {
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,no_schema,no_desc,good');
    __resetExtensionsForTests();
    const noSchema: Partial<ToolDefinition> = fullDefinition('codegraph_no_schema');
    delete noSchema.inputSchema;
    const noDesc: Partial<ToolDefinition> = fullDefinition('codegraph_no_desc');
    delete noDesc.description;
    const stderr = stderrDuring(() => {
      registerExtension({
        name: 'shape',
        tools: [
          { definition: noSchema as unknown as ToolDefinition, handle: reply('never') },
          { definition: noDesc as unknown as ToolDefinition, handle: reply('never') },
          { definition: fullDefinition('codegraph_good'), handle: reply('good') },
        ],
      });
    });
    expect(stderr).toContain('[CodeGraph] extension shape: tool codegraph_no_schema dropped: `inputSchema` must be');
    expect(stderr).toContain('[CodeGraph] extension shape: tool codegraph_no_desc dropped: `description` must be a string');
    // No project open: withRequiredProjectPath reads every listed tool's inputSchema.properties.
    let listed: string[] = [];
    expect(() => { listed = names(new ToolHandler(null).getTools()); }).not.toThrow();
    expect(listed).toEqual(['codegraph_explore', 'codegraph_good']);
  });
});
