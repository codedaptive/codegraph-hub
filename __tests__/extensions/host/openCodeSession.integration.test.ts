import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instructionsForClient, toolsForClient } from '../../../src/mcp/session';
import { getStaticTools } from '../../../src/mcp/tools';
import { __resetExtensionsForTests, extensionTools, registerExtension } from '../../../src/extensions/host/registry';

vi.mock('../../../src/upgrade/update-check', () => ({ getUpdateNotice: () => null }));

const description = 'Use codegraph_blast, codegraph_grep, codegraph_orphans, codegraph_suspects, and codegraph_explore. Already codegraph_codegraph_blast.';
const rewritten = 'Use codegraph_codegraph_blast, codegraph_codegraph_grep, codegraph_codegraph_orphans, codegraph_codegraph_suspects, and codegraph_codegraph_explore. Already codegraph_codegraph_blast.';
const bareExtensionName = /(?<![A-Za-z0-9_])codegraph_(?:blast|grep|orphans|suspects)(?![A-Za-z0-9_])/;

beforeEach(() => {
  vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
  vi.stubEnv('CODEGRAPH_MCP_TOOLS', '');
  __resetExtensionsForTests();
  registerExtension({
    name: 'test extensions',
    tools: ['codegraph_blast', 'codegraph_grep', 'codegraph_orphans', 'codegraph_suspects'].map(name => ({
      definition: {
        name,
        description,
        inputSchema: { type: 'object', properties: { query: { type: 'string', description } } },
      },
      handle: () => ({ content: [] }),
    })),
  });
});

afterEach(() => {
  __resetExtensionsForTests();
  vi.unstubAllEnvs();
});

describe('OpenCode extension names in session output', () => {
  it('rewrites tool descriptions but leaves other clients and tool names unchanged', () => {
    const defs = [...getStaticTools(), ...extensionTools().map(tool => tool.definition)];
    expect(toolsForClient(defs, 'claude-code')).toEqual(defs);
    const result = toolsForClient(defs, 'opencode');
    expect(result.map(tool => tool.name)).toEqual(defs.map(tool => tool.name));
    for (const tool of result) {
      expect(tool.description).not.toMatch(bareExtensionName);
      if (['codegraph_blast', 'codegraph_grep', 'codegraph_orphans', 'codegraph_suspects'].includes(tool.name)) {
        expect(tool.description).toBe(rewritten);
      }
    }
  });

  it('rewrites property descriptions without changing other clients or double-prefixing names', () => {
    const defs = [...getStaticTools(), ...extensionTools().map(tool => tool.definition)];
    expect(toolsForClient(defs, 'claude-code')).toEqual(defs);
    for (const tool of toolsForClient(defs, 'opencode')) {
      for (const property of Object.values(tool.inputSchema.properties)) {
        expect(property.description).not.toMatch(bareExtensionName);
      }
      if (['codegraph_blast', 'codegraph_grep', 'codegraph_orphans', 'codegraph_suspects'].includes(tool.name)) {
        expect(tool.inputSchema.properties.query.description).toBe(rewritten);
      }
    }
  });

  it('rewrites extension and built-in names in instructions only for OpenCode', () => {
    const text = 'Use codegraph_blast and codegraph_explore; keep codegraph_codegraph_blast.';
    expect(instructionsForClient(text, 'claude-code')).toBe(text);
    expect(instructionsForClient(text, 'opencode')).toContain(
      'Use codegraph_codegraph_blast and codegraph_codegraph_explore; keep codegraph_codegraph_blast.',
    );
  });
});
