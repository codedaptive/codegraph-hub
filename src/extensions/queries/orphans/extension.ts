/**
 * Wires `codegraph orphans` into the CLI and the MCP surface through the
 * extension hook (`src/extensions/host/README.md`): `registerOrphansCommand`
 * adds the `orphans` command, `orphansTool` is the `codegraph_orphans` MCP
 * tool. The zone's `../extension.ts` contributes both, as it does blast's.
 *
 * The hook loads this module on the main thread of every CLI invocation and in
 * every query-pool worker, so its top level imports only `path` and types and
 * does no work: registering orphans adds nothing to startup. The project lookup
 * (`../../../directory`, and `../shared/nested-repo`, which loads the CodeGraph
 * class when it runs) and the report (`./index`: the database layer, the Rust parser,
 * ripgrep) are loaded with `await import(...)` inside the command's action and
 * the tool's handler, as the zone's `../extension.ts` does for grep. A dynamic
 * import works under vitest; a lazy `require` of a `.ts` file does not (see the
 * host registry).
 */
import * as path from 'path';
import type { Command } from 'commander';
import type { ToolResult } from '../../../mcp/tools';
import type { ExtensionTool } from '../../host/api';
import type { OrphansResult } from './index';

interface OrphansCommandOptions {
  base?: string;
  json?: boolean;
  path?: string;
}

/**
 * Add `codegraph orphans` to `program`. The project is resolved as for
 * `codegraph blast`: the nearest CodeGraph root at or above `--path` (default:
 * the working directory), or the resolved path itself when there is none or
 * its index leaves out the nested git repository `--path` is in, so
 * `runOrphans` prints its own no-index message and exits 1. A missing `--base`
 * is `runOrphans`'s message too (exit 1), rather than commander's.
 */
export function registerOrphansCommand(program: Command): void {
  program
    .command('orphans')
    .description('List the symbols added since the merge base of a base ref and HEAD that nothing uses')
    .option('-b, --base <ref>', 'Git ref whose merge base with HEAD the additions are counted from (required)')
    .option('--json', 'Print the report as JSON')
    .option('-p, --path <path>', 'Project path')
    .action(async (opts: OrphansCommandOptions) => {
      // program.parse() does not await an action, so a throw here (a failed
      // import included) would be an unhandled rejection: report it as a failure instead.
      let r: OrphansResult;
      try {
        const [{ findNearestCodeGraphRoot }, { isUncoveredNestedRepo }, { runOrphans }] = await Promise.all([
          import('../../../directory'),
          import('../shared/nested-repo'),
          import('./index'),
        ]);
        const start = path.resolve(opts.path ?? process.cwd());
        const found = findNearestCodeGraphRoot(start);
        const root = found && !(await isUncoveredNestedRepo(start, found)) ? found : start;
        r = await runOrphans(root, { base: opts.base, format: opts.json ? 'json' : 'text' });
      } catch (err) {
        r = { output: '', exitCode: 1, stderr: `✗ ${err instanceof Error ? err.message : String(err)}` };
      }
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
 * `codegraph_orphans`: off by default, meaning not listed unless
 * `CODEGRAPH_MCP_TOOLS` names it (e.g. `explore,orphans`). As with built-ins, a
 * call to it by name is still served when no allowlist is set (host README,
 * "Off by default").
 */
export const orphansTool: ExtensionTool = {
  definition: {
    name: 'codegraph_orphans',
    description:
      'Dead code a branch adds: the functions, methods and types added since the merge base of a base git ref ' +
      'and HEAD that nothing uses: no incoming edge in the index, no unresolved reference by that name from the same ' +
      'language, and (for an identifier name) no text match elsewhere in the indexed files (the report counts any ' +
      'the search could not read). Interface/protocol/trait implementations and the ' +
      'requirements of used ones, tests and code nested in them, program entry points (main, @main) and constructors ' +
      'of used types are excluded and counted. Symbols whose only uses are name-only or low-confidence resolver ' +
      'guesses, unresolved references by name, or text mentions (comments and strings included) are listed ' +
      'separately as "orphaned unless the guess is right", with that evidence. Use it before review to find ' +
      'code a change added but never wired in.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'REQUIRED: the root path of the code to query (or any directory inside it); the index of the repository it is in is the one used. There is no default project.',
        },
        base: {
          type: 'string',
          description: 'Git ref the branch is compared against, e.g. "origin/main" or a tag. Required.',
        },
        format: {
          type: 'string',
          description: 'Output format. Default text.',
          enum: ['text', 'json'],
        },
      },
    },
  },
  async handle(args, ctx): Promise<ToolResult> {
    // null is absent, as the host's own projectPath check treats it.
    const absent = (v: unknown): unknown => (v === null ? undefined : v);
    const projectPath = absent(args.projectPath);
    const base = absent(args.base);
    const format = absent(args.format);
    if (projectPath !== undefined && typeof projectPath !== 'string') {
      return guidance('✗ projectPath must be a string path to the project.');
    }
    if (base === undefined || base === '') {
      return guidance('✗ base is required: the git ref to compare against, e.g. "origin/main". Orphans lists the ' +
        'symbols added since the merge base of base and HEAD.');
    }
    if (typeof base !== 'string') {
      return guidance('✗ base must be a git ref given as a string, e.g. "origin/main".');
    }
    if (format !== undefined && typeof format !== 'string') {
      return guidance('✗ format must be text or json.');
    }
    // getCodeGraph resolves a subdirectory to its project, and throws
    // NotIndexedError and the rest, which the ToolHandler shapes.
    const root = ctx.getCodeGraph(projectPath).getProjectRoot();
    // Loaded here, not at the top: see the header.
    const { orphansToolHandler } = await import('./index');
    // When not on a query-pool worker this runs on the main thread, and git plus
    // the queries block it for as long as they take.
    return orphansToolHandler({ projectPath: root, base, format });
  },
};
