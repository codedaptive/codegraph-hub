/**
 * Property schema type arrays: a JSON Schema property may name one type or a
 * list of types (src/mcp/tools.ts `PropertySchema.type`, widened from `string`
 * to `string | string[]`). The contract: an extension tool can declare
 * `type: ['string', 'integer']` with no cast, the schema it is published under
 * keeps that list unchanged, a scalar property in the same tool stays a string,
 * and `projectPath` is still required.
 *
 * The two halves of this file do not fail the same way, on purpose:
 *
 * - Compile time is the red. Before the fix `PropertySchema.type` is `string`,
 *   so the `limit` literal in `probeTool()`, typed `ExtensionTool` with no cast,
 *   does not compile: TS2322, "Type 'string[]' is not assignable to type
 *   'string'" on the `type` key of `limit`. vitest does not type-check and
 *   tsconfig.json excludes `__tests__`, so the error appears only in an ad-hoc
 *   tsc over this file. No runtime test can see it.
 * - Runtime is green before the fix. The registry copies the definition as JSON
 *   and `allToolDefinitions` spreads its properties untouched, so
 *   `['string', 'integer']` already reaches `getStaticTools()` and
 *   `ToolHandler.getTools()`. These tests pin that publication path so the
 *   widening cannot ship alongside a coercion that drops the list. They are not
 *   a runtime red, and nothing here is changed to make them one.
 *
 * Modelled on extension-hooks.test.ts: the registry is reset per test, and the
 * allowlist names the tool so it is listed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolHandler, getStaticTools } from '../../../src/mcp/tools';
import type { ToolDefinition } from '../../../src/mcp/tools';
import { __resetExtensionsForTests, registerExtension } from '../../../src/extensions/host/registry';
import type { ExtensionTool } from '../../../src/extensions/host/api';

const TOOL = 'codegraph_typearray_probe';

/**
 * One multi-type property and one scalar property, both written as literals with
 * no cast. The `limit` line is the compile-time red before the fix.
 */
function probeTool(): ExtensionTool {
  return {
    definition: {
      name: TOOL,
      description: 'Type-array probe: one property that accepts two types, one scalar property.',
      inputSchema: {
        type: 'object',
        properties: {
          projectPath: { type: 'string', description: 'Root of the project to query.' },
          limit: { type: ['string', 'integer'], description: 'A count, or a word for all.' },
          mode: { type: 'string', description: 'A scalar choice.' },
        },
      },
    },
    handle: () => ({ content: [{ type: 'text', text: 'typearray ran' }] }),
  };
}

/** The probe as each listing publishes it: the static surface, then the handler's. */
function published(): Array<[string, ToolDefinition | undefined]> {
  return [
    ['getStaticTools', getStaticTools().find(t => t.name === TOOL)],
    ['ToolHandler.getTools', new ToolHandler(null).getTools().find(t => t.name === TOOL)],
  ];
}

describe('property schema type arrays: an extension tool publishes its declared types unchanged', () => {
  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,typearray_probe');
    __resetExtensionsForTests();
    registerExtension({ name: 'typearray', tools: [probeTool()] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetExtensionsForTests();
  });

  it('publishes a property that accepts two types with its list unchanged, on both listings', () => {
    for (const [surface, tool] of published()) {
      expect(tool, surface).toBeDefined();
      expect(tool?.inputSchema.properties.limit?.type, surface).toEqual(['string', 'integer']);
    }
  });

  it('keeps a scalar property in the same tool a string, and still marks projectPath required, on both listings', () => {
    for (const [surface, tool] of published()) {
      expect(tool, surface).toBeDefined();
      expect(tool?.inputSchema.properties.mode?.type, surface).toBe('string');
      expect(tool?.inputSchema.required, surface).toContain('projectPath');
    }
  });
});
