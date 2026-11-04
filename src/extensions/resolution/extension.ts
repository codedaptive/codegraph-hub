/**
 * The resolution zone's extension (src/extensions/host/README.md): the
 * `codegraph suspects` CLI command and the `codegraph_suspects` MCP tool, both
 * over findSuspects / formatSuspects / suspectsToJson (./suspects).
 *
 * Default limits: the CLI lists 50 targets, the MCP tool 25, each with 5 sample
 * edges. A large repo has tens of thousands of suspect targets, so an unbounded
 * default would flood a terminal and blow an agent's context; `all` lifts the
 * target limit on both surfaces.
 *
 * findSuspects opens its own read-only second connection to the project's
 * index, because CodeGraph's database handle is private; the queries zone's
 * blast and grep do the same. The tool resolves the project through
 * ctx.getCodeGraph first, so a missing index and a refused path get the
 * built-in handlers' responses before that connection is opened.
 *
 * The tool is off by default: not listed unless CODEGRAPH_MCP_TOOLS names
 * `suspects` (e.g. `explore,suspects`). As with built-ins, a call to it by name
 * is still served when no allowlist is set (host README, "Off by default").
 *
 * The host loads this module in every CLI invocation that reaches
 * program.parse() and, in a query-pool worker, on its first call of a
 * non-built-in tool, so the top level defines values and does no work, and
 * imports only `path` and types. Project-root lookup (../../directory, which
 * imports ./db/node-sqlite) and the suspects library (./suspects, which pulls
 * in the db and resolution layers) are both lazy for that reason: they are
 * loaded with `await import()` inside the command's action and the tool's
 * handler; `await import()` of a `.ts` module works under vitest, where a lazy
 * `require` would not.
 */
import * as path from 'path';
import type { Command } from 'commander';
import type { ToolResult } from '../../mcp/tools';
import type { CodegraphExtension, ExtensionTool } from '../host/api';

/** CLI default target limit. */
const CLI_DEFAULT_LIMIT = 50;
/** MCP default target limit: smaller than the CLI's, since every line lands in an agent's context. */
const MCP_DEFAULT_LIMIT = 25;
/** Sample edges listed per target on both surfaces (findSuspects' own default). */
const DEFAULT_MAX_EDGES = 5;

/**
 * A parsed numeric option: the value (undefined meaning no limit), or
 * `{ ok: false }`, a bare refusal that carries no reason; the caller writes
 * the message.
 */
type Parsed = { ok: true; value: number | undefined } | { ok: false };

/**
 * A target limit: a positive integer (number or digit string) or "all"
 * (case-insensitive), which means no limit and yields undefined, never
 * Infinity or NaN.
 */
function parseLimit(v: unknown): Parsed {
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.toLowerCase() === 'all') return { ok: true, value: undefined };
    if (!/^\d+$/.test(s)) return { ok: false };
    v = Number(s);
  }
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return { ok: true, value: v };
  return { ok: false };
}

/** A per-target edge count: a non-negative integer (number or digit string). */
function parseEdges(v: unknown): Parsed {
  if (typeof v === 'string') {
    const s = v.trim();
    if (!/^\d+$/.test(s)) return { ok: false };
    v = Number(s);
  }
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return { ok: true, value: v };
  return { ok: false };
}

interface SuspectsCommandOptions {
  path?: string;
  json?: boolean;
  limit?: string;
  edges?: string;
}

/**
 * Add `codegraph suspects` to `program`. The project is the nearest CodeGraph
 * root at or above `--path` (default: the working directory). A bad --limit or
 * --edges, or no index at or above the path, prints a ✗ line on stderr,
 * nothing on stdout, and exits 1. The action is async (its modules load on
 * first use); commander's `parse()` does not await it, but the process stays
 * up until it settles, and it sets `process.exitCode` rather than exiting.
 */
export function registerSuspectsCommand(program: Command): void {
  program
    .command('suspects')
    .description('List call edges the resolver bound by name only, ranked by how likely each is wrong (std-collision (Rust and Swift), missing-import, several-definitions, low-confidence)')
    .option('-p, --path <path>', 'Project path (default: the nearest indexed project at or above the current directory)')
    .option('--json', 'Print { version: 1, suspects } as JSON')
    .option('-l, --limit <n|all>', `How many targets to list, or "all" (default: ${CLI_DEFAULT_LIMIT})`)
    .option('-e, --edges <n>', `Sample edges listed per target (default: ${DEFAULT_MAX_EDGES})`)
    .action(async (opts: SuspectsCommandOptions) => {
      // Not process.exit() anywhere here: exiting can cut off stdout that is
      // still draining into a pipe.
      const limit = opts.limit === undefined ? { ok: true as const, value: CLI_DEFAULT_LIMIT } : parseLimit(opts.limit);
      if (!limit.ok) {
        process.stderr.write(`✗ --limit must be a positive integer or "all", got "${opts.limit}".\n`);
        process.exitCode = 1;
        return;
      }
      const edges = opts.edges === undefined ? { ok: true as const, value: DEFAULT_MAX_EDGES } : parseEdges(opts.edges);
      if (!edges.ok) {
        process.stderr.write(`✗ --edges must be a non-negative integer, got "${opts.edges}".\n`);
        process.exitCode = 1;
        return;
      }
      const start = path.resolve(opts.path ?? process.cwd());
      // The imports sit inside the try, so a module that fails to load ends as
      // the ✗ line below with exit 1, not an unhandled rejection.
      try {
        const { findNearestCodeGraphRoot } = await import('../../directory');
        const root = findNearestCodeGraphRoot(start);
        if (!root) {
          process.stderr.write(`✗ No CodeGraph index at or above ${start}. Run \`codegraph init\` in the project first.\n`);
          process.exitCode = 1;
          return;
        }
        const { findSuspects, formatSuspects, suspectsToJson } = await import('./suspects');
        const list = findSuspects(root, { limit: limit.value, maxEdgesPerTarget: edges.value });
        process.stdout.write(
          opts.json ? `${JSON.stringify(suspectsToJson(list), null, 2)}\n` : `${formatSuspects(list)}\n`,
        );
        process.exitCode = 0;
      } catch (err) {
        // An index that exists but cannot be read (locked, corrupt, an older
        // schema), or a module that failed to load.
        process.stderr.write(`✗ suspects failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });
}

/** A success-shaped answer (never `isError`: errors teach an agent to stop calling the tool). */
function guidance(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** `codegraph_suspects`. Annotations are left to the registry, which sets the built-ins' read-only ones. */
export const suspectsTool: ExtensionTool = {
  definition: {
    name: 'codegraph_suspects',
    description:
      'Lists the call edges the resolver bound by name only or with low confidence, i.e. the calls most ' +
      'likely to point at the wrong definition, ranked by how suspicious they are. Each edge is flagged ' +
      'std-collision (Rust and Swift: the name is a standard-library method, so a stdlib call may have been bound to a ' +
      'project method), missing-import (caller and target are in different modules and the caller does not ' +
      'import the target\'s), several-definitions (more than one definition of the name exists) or ' +
      'low-confidence. Returns ranked targets, each with its edge count, flags and up to maxEdgesPerTarget ' +
      'sample edges (caller, file, line). Use it to audit the call graph before trusting a flow through ' +
      'a common name.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          // The server has no default project: it answers a call without this
          // argument with "missing argument: root path to the code you wish to
          // query" (src/extensions/host/server/repo-anchor.ts).
          description:
            'REQUIRED: the root path of the code to query (or any directory inside it); the report covers the ' +
            'project whose index that path belongs to. There is no default project: a call without it is ' +
            'answered "missing argument: root path to the code you wish to query".',
        },
        limit: {
          // integer, not number: parseLimit takes a positive safe integer, a
          // digit string, or "all", so a fractional number is refused.
          type: ['string', 'integer'],
          description: `How many targets to list: a positive integer as a string or number, or "all". Default ${MCP_DEFAULT_LIMIT}.`,
        },
        maxEdgesPerTarget: {
          type: 'number',
          description: `Sample edges listed per target, a non-negative integer; 0 lists none but keeps each edge count. Default ${DEFAULT_MAX_EDGES}.`,
        },
        format: {
          type: 'string',
          description: 'Output format: text, or json ({ version: 1, suspects }). Default text.',
          enum: ['text', 'json'],
        },
      },
    },
  },
  async handle(args, ctx): Promise<ToolResult> {
    // null is absent, as the host's own projectPath check treats it.
    const absent = (v: unknown): unknown => (v === null ? undefined : v);
    const projectPath = absent(args.projectPath);
    const limitArg = absent(args.limit);
    const edgesArg = absent(args.maxEdgesPerTarget);
    const format = absent(args.format);
    // Through ToolHandler.execute a non-string projectPath never gets here: its
    // central validateOptionalPath answers it first, with isError. This check
    // covers a direct call to handle().
    if (projectPath !== undefined && typeof projectPath !== 'string') {
      return guidance('✗ projectPath must be a string path to the project.');
    }
    const limit = limitArg === undefined ? { ok: true as const, value: MCP_DEFAULT_LIMIT } : parseLimit(limitArg);
    if (!limit.ok) return guidance('✗ limit must be a positive integer or "all".');
    const edges = edgesArg === undefined ? { ok: true as const, value: DEFAULT_MAX_EDGES } : parseEdges(edgesArg);
    if (!edges.ok) return guidance('✗ maxEdgesPerTarget must be a non-negative integer.');
    if (format !== undefined && format !== 'text' && format !== 'json') {
      return guidance('✗ format must be text or json.');
    }
    // getCodeGraph resolves a subdirectory to its project, and throws
    // NotIndexedError and the rest, which the ToolHandler shapes.
    const root = ctx.getCodeGraph(projectPath).getProjectRoot();
    // Loaded here rather than at the top level, which must stay light (see the
    // header).
    const { findSuspects, formatSuspects, suspectsToJson } = await import('./suspects');
    const list = findSuspects(root, { limit: limit.value, maxEdgesPerTarget: edges.value });
    return guidance(format === 'json' ? JSON.stringify(suspectsToJson(list), null, 2) : formatSuspects(list));
  },
};

const extension: CodegraphExtension = {
  name: 'resolution',
  registerCommands(program) {
    registerSuspectsCommand(program);
  },
  tools: [suspectsTool],
};

export default extension;
