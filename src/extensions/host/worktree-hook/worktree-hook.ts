/**
 * Worktree PreToolUse hook: the decision logic, pure apart from one git call and one directory check.
 *
 * Claude Code runs a PreToolUse hook command before each tool call and sends it the call as JSON on stdin.
 * For a call to a codegraph MCP tool this hook answers with the same input plus `projectPath` set to the
 * git root of the call's own cwd. An agent in a linked worktree therefore queries that worktree's own index
 * (the worktree seeder copies one in when it has none), not the main checkout's, and an agent that passed no
 * projectPath, or a wrong one, gets the right one. Every other call gets no answer, and the tool runs unchanged.
 *
 * The root replaces whatever projectPath the agent passed, a sub-project path included. That assumes the
 * worktree's index sits at its git root: the lookup walks up from the root, so an index that exists only in
 * a sub-project (a monorepo where `codegraph init` ran inside one package) is not reached through this hook.
 *
 * Imports only Node built-ins and `src/sync/worktree.ts` (itself fs, path and child_process), so starting
 * the hook loads no engine, database, MCP or extraction code.
 */
import * as fs from 'fs';
import { gitWorktreeRoot } from '../../../sync/worktree';

/**
 * Tool-name prefix of the codegraph MCP server. Claude Code names an MCP tool `mcp__<server key>__<tool>`,
 * so the prefix is the server key `codegraph`. A plugin-bundled server names its tools
 * `mcp__plugin_<plugin>_<server>__<tool>`, so this prefix does not match them.
 */
const CODEGRAPH_TOOL_PREFIX = 'mcp__codegraph__';

/**
 * The one `GIT_*` variable the hook keeps: where git finds its helper programs. On some installs git cannot
 * run `rev-parse` without it, so removing it would make the hook fail open on every call.
 */
const GIT_VARIABLE_KEPT = 'GIT_EXEC_PATH';

/**
 * Deletes every environment variable whose name starts with `GIT_` from `env`, in place, except
 * `GIT_EXEC_PATH`. main.ts calls it on `process.env` before `decideHookOutput`, which is safe because the
 * hook process lives for one call.
 *
 * Why all of them and not a list: the hook's one job is to resolve the root from the payload's cwd alone, and
 * the hook process inherits Claude Code's environment. A Claude Code started from a git hook, or from a shell
 * that exports git variables, would otherwise have every codegraph call answered for the wrong place.
 * GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR and GIT_INDEX_FILE name another repository outright;
 * GIT_CEILING_DIRECTORIES stops the walk up from the cwd short of the root, so the lookup finds nothing and the
 * agent's own projectPath survives; GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT/KEY_n/VALUE_n can inject
 * `core.worktree` and similar. A fixed list would miss the next variable git adds, and none of them is
 * something this hook's one `git rev-parse --show-toplevel` needs.
 *
 * HOME is not touched, so `~/.gitconfig` still applies, `safe.directory` included. The name is matched
 * case-insensitively because Windows environment names are.
 */
export function clearGitEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (upper.startsWith('GIT_') && upper !== GIT_VARIABLE_KEPT) delete env[name];
  }
}

/** A plain JSON object: not null, not an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `dir` names an existing directory. A missing path, a file or an unreadable path is false. */
function isExistingDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The hook's stdout for one stdin payload: one JSON line to print, or null to print nothing.
 *
 * Returns the line only when `tool_name` starts with `mcp__codegraph__`, `tool_input` is a plain object,
 * `cwd` is a string naming an existing directory, and git reports a toplevel for it.
 * `updatedInput` replaces the whole tool input, so it carries every original key with `projectPath` set
 * (or added). It is paired with permissionDecision "allow", not "ask": the hooks doc pairs `updatedInput`
 * with `allow` (auto-approve) or `ask` (show the modified input) and says `defer` ignores it; `allow` is
 * chosen so the call does not prompt each time. Allow is granted on the tool-name prefix alone, so any
 * server keyed `codegraph` gets it (the hooks doc advises basing trust on `mcp_server.source`). The codegraph
 * tools do not edit source files, but they can update the project's `.codegraph/` index and seed one into a
 * new worktree. The user's own deny and ask permission rules are still evaluated after a hook's allow.
 *
 * It runs git with the process's own environment, so a caller that must not let inherited `GIT_*` variables
 * (GIT_DIR, GIT_CEILING_DIRECTORIES and the rest) win over the payload's cwd calls `clearGitEnvironment`
 * first; main.ts does.
 *
 * Never throws. Anything unexpected (bad JSON, empty input, a missing field, a cwd outside a git repo, git
 * missing) returns null, so the hook fails open and the tool call goes ahead as the agent wrote it.
 */
export function decideHookOutput(stdin: string): string | null {
  try {
    const payload: unknown = JSON.parse(stdin);
    if (!isPlainObject(payload)) return null;

    const { tool_name: toolName, tool_input: toolInput, cwd } = payload;
    if (typeof toolName !== 'string' || !toolName.startsWith(CODEGRAPH_TOOL_PREFIX)) return null;
    if (!isPlainObject(toolInput)) return null;
    if (typeof cwd !== 'string' || !isExistingDirectory(cwd)) return null;

    const root = gitWorktreeRoot(cwd);
    if (root === null) return null;

    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...toolInput, projectPath: root },
      },
    });
  } catch {
    return null;
  }
}
