/**
 * The projectPath argument of the queries extension's MCP tools is required
 * and has no default: the server answers a call without it with "missing
 * argument: root path to the code you wish to query", so the description
 * tools/list serves must not say a session project is used when it is omitted.
 *
 * Entry point: getStaticTools(), which is what tools/list serves for the
 * extension tools. The host adds `projectPath` to `required` there
 * (withRequiredProjectPath), so the required check asserts that too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getStaticTools } from '../../../src/mcp/tools';
import { __resetExtensionsForTests, registerExtension } from '../../../src/extensions/host/registry';
import queriesExtension from '../../../src/extensions/queries/extension';

interface ListedTool {
  name: string;
  inputSchema: {
    properties: Record<string, { description?: string }>;
    required?: string[];
  };
}

const QUERY_TOOLS = ['codegraph_blast', 'codegraph_orphans', 'codegraph_grep'];

// selectIndexRoot (src/extensions/host/server/index-root.ts) skips an index strictly below the git
// worktree root and answers from the repository-level one, so "the nearest .codegraph/" is false.
const STALE_NEAREST_INDEX_CLAIM = 'nearest .codegraph';

describe('queries extension: projectPath is required, with no default project', () => {
  beforeEach(() => {
    __resetExtensionsForTests();
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'blast,orphans,grep');
    registerExtension(queriesExtension);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetExtensionsForTests();
  });

  const listed = (): Map<string, ListedTool> =>
    new Map((getStaticTools() as unknown as ListedTool[]).map((t) => [t.name, t]));

  for (const name of QUERY_TOOLS) {
    describe(name, () => {
      it('lists the tool when the allowlist names it', () => {
        expect(listed().has(name)).toBe(true);
      });

      it('does not describe projectPath as defaulting to the session project', () => {
        const desc = listed().get(name)?.inputSchema.properties.projectPath?.description ?? '';
        expect(desc).not.toContain('Defaults to');
        expect(desc).not.toContain('session project');
      });

      it('does not claim the nearest .codegraph/ is used (the repository-level index is)', () => {
        const desc = listed().get(name)?.inputSchema.properties.projectPath?.description ?? '';
        expect(desc).not.toContain(STALE_NEAREST_INDEX_CLAIM);
      });

      it('describes projectPath as REQUIRED', () => {
        const desc = listed().get(name)?.inputSchema.properties.projectPath?.description ?? '';
        expect(desc).toMatch(/^REQUIRED\b/);
      });

      it('lists projectPath in inputSchema.required', () => {
        expect(listed().get(name)?.inputSchema.required ?? []).toContain('projectPath');
      });
    });
  }
});
