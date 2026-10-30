/**
 * The host zone's extension (./README.md): the `codegraph checkpoint [path] [--fresh] [-j, --json]` CLI
 * command, which reports the workspace state the index reflects (git HEAD, a hash of the uncommitted
 * changes, files the index has not caught up with) and exits 0 fresh, 3 not fresh, 1 on error.
 *
 * The host loads this module on the main thread of every CLI invocation that reaches `program.parse()`
 * (`serve --mcp` included; not the bare installer run or -v / -version), and a query-pool worker loads
 * it on its first call of a tool that is not built in, so loading it must not load the engine, the
 * database layer or the MCP tool handler. Its top level has type imports only; the command's work
 * (./fresh/cli, which loads the directory and glyph helpers and ./fresh/checkpoint, and loads the engine
 * with `await import` only when the command runs) is imported inside the action.
 * It must not value-import ./registry or src/mcp/tools.ts.
 */
import type { Command } from 'commander';
import type { CodegraphExtension } from './api';

function registerCheckpointCommand(program: Command): void {
  program
    .command('checkpoint [path]')
    .description('Show the workspace state the index reflects (git HEAD, uncommitted-change hash, files pending); exit 0 fresh, 3 not fresh')
    .option('--fresh', 'Bring the index up to date with the working tree first (bounded by CODEGRAPH_FRESH_TIMEOUT_MS, default 30000); a sync still running at the bound is waited for after printing, before exit (bounded by CODEGRAPH_FRESH_SETTLE_TIMEOUT_MS, default 600000)')
    .option('-j, --json', 'Output as JSON')
    .action(async (pathArg: string | undefined, options: { fresh?: boolean; json?: boolean }) => {
      const { runCheckpointCommand } = await import('./fresh/cli');
      await runCheckpointCommand(pathArg, options);
    });
}

const extension: CodegraphExtension = {
  name: 'host',
  registerCommands(program) {
    registerCheckpointCommand(program);
  },
};

export default extension;
