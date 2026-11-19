import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openCodeRewrittenToolNames } from '../../../src/mcp/openCodeRewrittenToolNames';
import { __resetExtensionsForTests, registerExtension } from '../../../src/extensions/host/registry';

beforeEach(() => {
  vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
  __resetExtensionsForTests();
});

afterEach(() => {
  __resetExtensionsForTests();
  vi.unstubAllEnvs();
});

describe('openCodeRewrittenToolNames', () => {
  it('includes built-in and registered extension tool names', () => {
    registerExtension({
      name: 'test extensions',
      tools: ['codegraph_blast', 'codegraph_grep', 'codegraph_orphans', 'codegraph_suspects'].map(name => ({
        definition: { name, description: 'A test tool', inputSchema: { type: 'object', properties: {} } },
        handle: () => ({ content: [] }),
      })),
    });

    expect(openCodeRewrittenToolNames()).toEqual(expect.arrayContaining([
      'codegraph_search',
      'codegraph_callers',
      'codegraph_callees',
      'codegraph_impact',
      'codegraph_node',
      'codegraph_explore',
      'codegraph_status',
      'codegraph_files',
      'codegraph_blast',
      'codegraph_grep',
      'codegraph_orphans',
      'codegraph_suspects',
    ]));
  });

  it('includes an extension registered after an earlier call', () => {
    expect(openCodeRewrittenToolNames()).not.toContain('codegraph_later_tool');
    registerExtension({
      name: 'late extension',
      tools: [{
        definition: {
          name: 'codegraph_later_tool',
          description: 'A later test tool',
          inputSchema: { type: 'object', properties: {} },
        },
        handle: () => ({ content: [] }),
      }],
    });

    expect(openCodeRewrittenToolNames()).toContain('codegraph_later_tool');
  });
});
