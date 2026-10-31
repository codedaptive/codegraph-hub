/**
 * The queries zone's extension (src/extensions/host/README.md): the
 * `codegraph grep` CLI command and the `codegraph_grep` MCP tool, both over
 * grep-by-symbol (./grep); the `codegraph blast` CLI command and the
 * `codegraph_blast` MCP tool (./blast/extension); and the `codegraph orphans`
 * CLI command and the `codegraph_orphans` MCP tool (./orphans/extension).
 *
 * The host loads this module on the main thread of every CLI invocation and in
 * every query-pool worker, so loading it must not load the database layer.
 * Its top level imports only the tool definitions (plain data), types and
 * blast's and orphans' wiring modules, which follow the same rule. Grep's
 * search and all of blast's and orphans' work, which pull in the database
 * layer, are imported inside the commands' actions and the tools' handlers.
 */
import type { Command } from 'commander';
import type { CodegraphExtension } from '../host/api';
import { GREP_TOOL } from './grep/grep-definition';
import { blastTool, registerBlastCommand } from './blast/extension';
import { orphansTool, registerOrphansCommand } from './orphans/extension';

interface GrepCliOptions {
  in?: string;
  fixed?: boolean;
  ignoreCase?: boolean;
  strict?: boolean;
  json?: boolean;
  path?: string;
}

/**
 * The argv runGrepCommand parses, rebuilt from what commander parsed. The
 * pattern always goes last, after `--`, so a pattern that begins with `-`
 * (which the user passed after `--`) is read as the pattern, not a flag.
 */
export function grepArgv(pattern: string, opts: GrepCliOptions): string[] {
  const argv: string[] = [];
  if (opts.in !== undefined) argv.push('--in', opts.in);
  if (opts.fixed) argv.push('--fixed');
  if (opts.ignoreCase) argv.push('--ignore-case');
  if (opts.strict) argv.push('--strict');
  if (opts.json) argv.push('--json');
  if (opts.path !== undefined) argv.push('--path', opts.path);
  argv.push('--', pattern);
  return argv;
}

function registerGrepCommand(program: Command): void {
  program
    .command('grep')
    .argument('<pattern>', 'regex (valid as both a JavaScript and a ripgrep regex), or a literal with --fixed; for a pattern that starts with "-", put the options first, then -- and the pattern; the CLI drops every --color and --no-color word, even after --, so search for those with a regex such as [-]-color')
    .description('Search every indexed file, with each hit grouped under its enclosing symbol and the groups ranked by incoming edges')
    .option('--in <path>', 'repo-relative path prefix to search under, e.g. src/db')
    .option('--fixed', 'treat the pattern as a literal string, not a regex')
    .option('-i, --ignore-case', 'case-insensitive match')
    .option('--strict', 'Leave name-matched (questionable) incoming calls out of the in-edge counts and ranking')
    .option('--json', 'print the structured result as JSON')
    .option('-p, --path <path>', 'project path (default: the nearest indexed project at or above the current directory)')
    .action(async (pattern: string, opts: GrepCliOptions) => {
      try {
        const { runGrepCommand } = await import('./grep/grep-command');
        const out = await runGrepCommand(grepArgv(pattern, opts), process.cwd());
        if (out.stdout) process.stdout.write(out.stdout);
        if (out.stderr) process.stderr.write(out.stderr);
        process.exitCode = out.exitCode;
      } catch (err) {
        // runGrepCommand answers every expected condition itself; what reaches
        // here is a real malfunction, e.g. ripgrep missing.
        process.stderr.write(`✗ grep failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });
}

const extension: CodegraphExtension = {
  name: 'queries',
  registerCommands(program) {
    registerGrepCommand(program);
    registerBlastCommand(program);
    registerOrphansCommand(program);
  },
  tools: [
    {
      definition: GREP_TOOL,
      /**
       * Resolves the project through ctx.getCodeGraph, so a project with no
       * index and a refused path get the built-in handlers' responses
       * (executeReadTool turns its NotIndexedError into success-shaped
       * guidance and its PathRefusalError into isError), then searches that
       * project's root. handleGrepTool checks the root with
       * validateProjectPath again before searching. It also gets the session's
       * focus (ctx.focus, `[]` when the context has none), which narrows the
       * search unless the call passes `scope: "repo"`.
       */
      async handle(args, ctx) {
        const projectPath = typeof args.projectPath === 'string' && args.projectPath !== '' ? args.projectPath : undefined;
        const root = ctx.getCodeGraph(projectPath).getProjectRoot();
        const { handleGrepTool } = await import('./grep/grep-mcp');
        const { projectPath: _resolved, ...rest } = args;
        return handleGrepTool(rest, root, ctx.focus ?? []);
      },
    },
    blastTool,
    orphansTool,
  ],
};

export default extension;
