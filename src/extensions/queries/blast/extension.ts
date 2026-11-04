/**
 * Wires `codegraph blast` into the CLI and the MCP surface through the
 * extension hook (`src/extensions/host/README.md`): `registerBlastCommand` adds
 * the `blast` command, `blastTool` is the `codegraph_blast` MCP tool. The zone's
 * `../extension.ts` contributes both.
 *
 * The hook loads this module on the main thread of every CLI invocation and in
 * every query-pool worker, so its top level imports only `path`, types and the
 * tool definition (plain data). The engine (`CodeGraph`, which pulls in the
 * database layer), project-root lookup, git helpers and blast itself are loaded
 * with `await import()` inside the command's action and the tool's handler, as
 * grep's are in `../extension.ts`; `await import()` of a `.ts` module works
 * under vitest, where a lazy `require` would not.
 *
 * The CLI command has no session, so it never sees a focus; the tool's handler
 * passes the session's (`ctx.focus`) to `blastToolHandler`.
 */
import * as path from 'path';
import type { Command } from 'commander';
import type { ToolResult } from '../../../mcp/tools';
import type { ExtensionTool } from '../../host/api';

interface BlastCommandOptions {
  base?: string;
  depth?: string;
  format?: string;
  path?: string;
  strict?: boolean;
}

/**
 * Add `codegraph blast` to `program`. The project is the nearest CodeGraph
 * root at or above `--path` (default: the working directory). With none, or
 * when that root's index leaves out the nested git repository `--path` is in
 * (`isUncoveredNestedRepo`, shared with `orphans` in `../shared/nested-repo.ts`),
 * the resolved path itself is passed, so `runBlast` prints its own no-index
 * message and exits 1. Depth and format defaults are `runBlast`'s (depth 2,
 * text). The action is async (its modules load on first use); commander's
 * `parse()` does not await it, but the process stays up until it settles, and
 * it sets `process.exitCode` rather than exiting.
 */
export function registerBlastCommand(program: Command): void {
  program
    .command('blast')
    .description('List the symbols and files that depend on the lines changed since a base ref, grouped by directory')
    .option('-b, --base <ref>', 'Git ref to compare against (default: the uncommitted changes against HEAD, or the last commit when the tree is clean)')
    .option('-d, --depth <n|all>', 'How many dependent hops to walk, or "all" (default: 2)')
    .option('-f, --format <text|json|markdown>', 'Output format (default: text)')
    .option('-p, --path <path>', 'Project path')
    .option('--strict', 'Leave out dependents reached only through name-matched (questionable) call edges')
    .action(async (opts: BlastCommandOptions) => {
      const start = path.resolve(opts.path ?? process.cwd());
      const { findNearestCodeGraphRoot } = await import('../../../directory');
      const { runBlast } = await import('./index');
      const { isUncoveredNestedRepo } = await import('../shared/nested-repo');
      const found = findNearestCodeGraphRoot(start);
      const root = found && !(await isUncoveredNestedRepo(start, found)) ? found : start;
      const r = runBlast(root, { base: opts.base, depth: opts.depth, format: opts.format, strict: opts.strict });
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
      'test files are counted, not listed. json also lists every changed file and changed symbol. A dependent ' +
      'reached only through name-matched calls (the resolver matched the name, not a declared target) is marked ' +
      'questionable; strict: true leaves those dependents out. In a session started with --focus it still ' +
      'covers the whole repository and lists the dependents outside the focus under "Outside focus (N)" ' +
      '(json: outsideFocus), after the ones inside it.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'REQUIRED: the root path of the code to query (or any directory inside it); the index of the repository it is in is the one used. There is no default project.',
        },
        base: {
          type: 'string',
          description: 'Git ref to compare against, e.g. "origin/main" or a tag. Omit to use the uncommitted ' +
            'changes against HEAD, or the last commit when the tree is clean.',
        },
        depth: {
          type: ['string', 'integer'],
          description: 'How many dependent hops to walk: a positive integer as a string or number, or "all" ' +
            '(also "full" or "max") for the full closure. Default 2.',
        },
        format: {
          type: 'string',
          description: 'Output format. Default text.',
          enum: ['text', 'json', 'markdown'],
        },
        strict: {
          type: 'boolean',
          description: 'Leave out dependents reached only through name-matched (questionable) call edges ' +
            'instead of marking them. Default false.',
        },
      },
    },
  },
  async handle(args, ctx): Promise<ToolResult> {
    // null is absent, as the host's own projectPath check treats it.
    const absent = (v: unknown): unknown => (v === null ? undefined : v);
    const projectPath = absent(args.projectPath);
    const base = absent(args.base);
    const depth = absent(args.depth);
    const format = absent(args.format);
    const strict = absent(args.strict);
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
    if (strict !== undefined && typeof strict !== 'boolean') {
      return guidance('✗ strict must be true or false.');
    }
    // getCodeGraph resolves a subdirectory to its project, and throws
    // NotIndexedError and the rest, which the ToolHandler shapes.
    const root = ctx.getCodeGraph(projectPath).getProjectRoot();
    // When not on a query-pool worker this runs on the main thread, and git plus the
    // graph walk block it for as long as the diff takes.
    const { blastToolHandler } = await import('./index');
    // The session focus (`serve --mcp --focus`) does not limit the walk: blast covers the
    // whole repository, and the dependents outside the focus go under "Outside focus".
    return blastToolHandler({ projectPath: root, base, depth, format, strict, sessionFocus: ctx.focus ?? [] });
  },
};
