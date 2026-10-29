/**
 * Wires `codegraph blast` into the CLI and the MCP surface through the
 * extension hook (`src/extensions/host/README.md`): `registerBlastCommand` adds
 * the `blast` command, `blastTool` is the `codegraph_blast` MCP tool. The zone's
 * `../extension.ts` contributes both.
 *
 * Static imports only: a lazy `require` of a `.ts` file fails under vitest
 * (see the host registry). The top level defines values and does no work,
 * because the hook loads this module on the main thread and in every
 * query-pool worker.
 */
import * as path from 'path';
import type { Command } from 'commander';
import { CodeGraph } from '../../../index';
import { findNearestCodeGraphRoot } from '../../../directory';
import { nestedRepositoryBelow } from '../../../sync/worktree';
import type { ToolResult } from '../../../mcp/tools';
import type { ExtensionTool } from '../../host/api';
import { blastToolHandler, runBlast } from './index';

interface BlastCommandOptions {
  base?: string;
  depth?: string;
  format?: string;
  path?: string;
}

/**
 * Whether `start` lies in a different git repository nested below `indexRoot`
 * whose files that index does not hold (typically a gitignored checkout such
 * as `vendor/child`). The CLI's form of the MCP rule in
 * `ToolHandler.uncoveredNestedRepo` (#2110), built from the same two checks:
 * `nestedRepositoryBelow` compares the git toplevels (and lets a linked
 * worktree of the index's own repository through), then the index is asked
 * whether it holds any file under that repository. A submodule or embedded
 * clone the parent index does cover is answered from it, as over MCP.
 *
 * An index that cannot be opened is no evidence the repository is excluded,
 * so it answers false and `runBlast` reports on the index as it stands.
 */
function isUncoveredNestedRepo(start: string, indexRoot: string): boolean {
  const nested = nestedRepositoryBelow(start, indexRoot);
  if (!nested) return false;
  let cg: CodeGraph | null = null;
  try {
    cg = CodeGraph.openSync(indexRoot, { readOnly: true });
    return !cg.hasFilesUnder(nested.relPath);
  } catch {
    return false;
  } finally {
    cg?.close();
  }
}

/**
 * Add `codegraph blast` to `program`. The project is the nearest CodeGraph
 * root at or above `--path` (default: the working directory). With none, or
 * when that root's index leaves out the nested git repository `--path` is in
 * (`isUncoveredNestedRepo`), the resolved path itself is passed, so `runBlast`
 * prints its own no-index message and exits 1. Depth and format defaults are
 * `runBlast`'s (depth 2, text).
 */
export function registerBlastCommand(program: Command): void {
  program
    .command('blast')
    .description('List the symbols and files that depend on the lines changed since a base ref, grouped by directory')
    .option('-b, --base <ref>', 'Git ref to compare against (default: the uncommitted changes against HEAD, or the last commit when the tree is clean)')
    .option('-d, --depth <n|all>', 'How many dependent hops to walk, or "all" (default: 2)')
    .option('-f, --format <text|json|markdown>', 'Output format (default: text)')
    .option('-p, --path <path>', 'Project path')
    .action((opts: BlastCommandOptions) => {
      const start = path.resolve(opts.path ?? process.cwd());
      const found = findNearestCodeGraphRoot(start);
      const root = found && !isUncoveredNestedRepo(start, found) ? found : start;
      const r = runBlast(root, { base: opts.base, depth: opts.depth, format: opts.format });
      if (r.output) process.stdout.write(r.output);
      if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
      // Not process.exit(): exiting here can cut off stdout that is still
      // draining into a pipe.
      process.exitCode = r.exitCode;
    });
}

/** A success-shaped answer (never `isError`: errors teach an agent to stop calling the tool). */
function guidance(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * `codegraph_blast`: off by default, meaning not listed unless
 * `CODEGRAPH_MCP_TOOLS` names it (e.g. `explore,blast`). As with built-ins, a
 * call to it by name is still served when no allowlist is set (host README,
 * "Off by default").
 */
export const blastTool: ExtensionTool = {
  definition: {
    name: 'codegraph_blast',
    description:
      'Blast radius of a diff: which symbols and files depend on the lines changed since a base git ref ' +
      '(or, with no base, the uncommitted changes against HEAD, or the last commit when the tree is clean), ' +
      'walked through the call/reference graph and grouped by directory. Use it to see what a branch or ' +
      'working-tree change can affect before reviewing or testing it. Returns, per directory area, each ' +
      'dependent with its file:line span, relation and depth; text lists up to 25 per area, and dependents in ' +
      'test files are counted, not listed. json also lists every changed file and changed symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the project (or any directory inside it). Defaults to the session project.',
        },
        base: {
          type: 'string',
          description: 'Git ref to compare against, e.g. "origin/main" or a tag. Omit to use the uncommitted ' +
            'changes against HEAD, or the last commit when the tree is clean.',
        },
        depth: {
          type: 'string',
          // PropertySchema.type is a single string, so the schema cannot say
          // ['string', 'number']; the handler takes either, and says so here.
          description: 'How many dependent hops to walk: a positive integer as a string or number, or "all" ' +
            '(also "full" or "max") for the full closure. Default 2.',
        },
        format: {
          type: 'string',
          description: 'Output format. Default text.',
          enum: ['text', 'json', 'markdown'],
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  handle(args, ctx): ToolResult {
    // null is absent, as the host's own projectPath check treats it.
    const absent = (v: unknown): unknown => (v === null ? undefined : v);
    const projectPath = absent(args.projectPath);
    const base = absent(args.base);
    const depth = absent(args.depth);
    const format = absent(args.format);
    if (projectPath !== undefined && typeof projectPath !== 'string') {
      return guidance('✗ projectPath must be a string path to the project.');
    }
    if (base !== undefined && typeof base !== 'string') {
      return guidance('✗ base must be a git ref given as a string, e.g. "origin/main".');
    }
    if (depth !== undefined && typeof depth !== 'string' && typeof depth !== 'number') {
      return guidance('✗ depth must be a positive number or "all".');
    }
    if (format !== undefined && typeof format !== 'string') {
      return guidance('✗ format must be text, markdown or json.');
    }
    // getCodeGraph resolves a subdirectory to its project, and throws
    // NotIndexedError and the rest, which the ToolHandler shapes.
    const root = ctx.getCodeGraph(projectPath).getProjectRoot();
    // When not on a query-pool worker this runs on the main thread, and git plus the
    // graph walk block it for as long as the diff takes.
    return blastToolHandler({ projectPath: root, base, depth, format });
  },
};
