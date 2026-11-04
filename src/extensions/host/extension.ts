/**
 * The host zone's extension (./README.md). Two CLI commands:
 *
 *   - `codegraph checkpoint [path] [--fresh] [-j, --json]` reports the workspace state the index
 *     reflects (git HEAD, a hash of the uncommitted changes, files the index has not caught up with)
 *     and exits 0 fresh, 3 not fresh, 1 on error;
 *   - `codegraph project list|pin|unpin|remove` lists, pins, unpins or unregisters the projects in the
 *     project registry (./worktree-lifecycle/project-registry.ts). A pinned project is never
 *     idle-released from an MCP server's project cache; `remove` deletes no file.
 *
 * The host loads this module on the main thread of every CLI invocation that reaches `program.parse()`
 * (`serve --mcp` included; not the bare installer run or -v / -version), and a query-pool worker loads
 * it on its first call of a tool that is not built in, so loading it must not load the engine, the
 * database layer or the MCP tool handler. Its top level has type imports only; each command's work is
 * imported inside its action: ./fresh/cli (which loads the directory and glyph helpers and
 * ./fresh/checkpoint, and loads the engine with `await import` only when the command runs) and
 * ./worktree-lifecycle/cli (the registry and its git helpers).
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

function registerProjectCommand(program: Command): void {
  const project = program
    .command('project')
    .description('List, pin, unpin or unregister the projects CodeGraph manages');

  project
    .command('list')
    .description('List registered projects')
    .option('-j, --json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const { runProjectList } = await import('./worktree-lifecycle/cli');
      runProjectList(options);
    });

  project
    .command('pin <path>')
    .description('Keep a project open in the CodeGraph MCP server (never idle-released)')
    .action(async (pathArg: string) => {
      const { runProjectPin } = await import('./worktree-lifecycle/cli');
      await runProjectPin(pathArg);
    });

  project
    .command('unpin <path>')
    .description('Let a pinned project be idle-released again')
    .action(async (pathArg: string) => {
      const { runProjectUnpin } = await import('./worktree-lifecycle/cli');
      runProjectUnpin(pathArg);
    });

  project
    .command('remove <path>')
    .description('Unregister a project (deletes nothing)')
    .action(async (pathArg: string) => {
      const { runProjectRemove } = await import('./worktree-lifecycle/cli');
      runProjectRemove(pathArg);
    });
}

const extension: CodegraphExtension = {
  name: 'host',
  registerCommands(program) {
    registerCheckpointCommand(program);
    registerProjectCommand(program);
  },
};

export default extension;
