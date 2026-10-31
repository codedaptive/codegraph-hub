/**
 * For tests that drive an MCP engine's ToolHandler directly, below the
 * session. A handler that owns a project lifecycle (every MCPEngine's) refuses a
 * call that arrives without a session's index admission check (ExecuteOptions),
 * so such a test passes this one, which admits every index root. The check the
 * sessions really make is covered where it lives: repo-anchor.unit.test.ts, the
 * machine-server gate and read-only-engine.gate.test.ts (the dispatch both
 * sessions and the proxy fallback share).
 */
import type { ExecuteOptions } from '../../src/mcp/tools';

export const ADMIT_ALL: ExecuteOptions = { admitIndexRoot: async () => null };
