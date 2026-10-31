/**
 * The extension hook's contract: what a zone's `src/extensions/<zone>/extension.ts`
 * exports (as `default`) to add CLI commands and MCP tools to CodeGraph without
 * editing upstream files. The loader and the validation rules live in
 * `./registry`; the prose contract is `./README.md`.
 *
 * Types only. Every import is `import type`, and a type-only import adds
 * nothing to the runtime graph, so this file cannot create a runtime cycle.
 */
import type { Command } from 'commander';
import type CodeGraph from '../../index';
import type { ToolDefinition, ToolResult } from '../../mcp/tools';

/** What an extension tool's handler gets from the ToolHandler that dispatched it. */
export interface ExtensionToolContext {
  /**
   * `projectPath`'s project when given, else the session default. Throws the
   * same errors the built-in handlers get (NotIndexedError, PathRefusalError,
   * the WSL-shared-index and database-open failures);
   * `ToolHandler.executeReadTool` turns them into the usual responses.
   */
  getCodeGraph(projectPath?: string): CodeGraph;
  /**
   * The calling session's focus for THIS call: the absolute canonical
   * directories its `--focus` named (each relative to the repository root),
   * resolved against the root of the git worktree the call is answered from,
   * so a call on a sibling worktree of the session's repository gets that
   * worktree's own directories, not the launch worktree's. `[]` when the
   * session has no focus (the whole repository), when no worktree can be
   * named for the call (no `projectPath` and no default project), and when
   * every entry was dropped (one that leaves the worktree through a symlink).
   * It is the session's own, set by the server for every call; an argument a
   * client sends cannot set it, and the tool's `args` never carry the internal
   * keys that transport it. A tool that narrows its results to the focus
   * compares an index against it with `focusPrefixesFor` / `inFocus`
   * (`./server/session-scope`).
   */
  readonly focus: readonly string[];
}

/** One MCP tool contributed by an extension. */
export interface ExtensionTool {
  /**
   * The tool's MCP definition, JSON data. `name` must match
   * `/^codegraph_[a-z][a-z0-9_]*$/` and must not collide with a built-in tool
   * or an earlier extension tool; `description` must be a string and
   * `inputSchema` an object with `type: 'object'` and a `properties` object.
   * The registry drops a tool that breaks a rule, or that has no `handle`
   * function. It keeps a frozen JSON copy taken once at registration, and that
   * copy is what is listed and looked up: changing this object afterwards
   * changes nothing. `annotations` are set by the registry, not here: every
   * extension tool is served with the built-in tools' read-only annotations,
   * and any the extension sets are replaced.
   */
  definition: ToolDefinition;
  /**
   * Runs the tool, with the tool object as `this`. Read once at registration.
   * Called on the main thread or inside a query-pool worker, so it must work
   * from `args` and `ctx` alone (no state set up elsewhere).
   */
  handle(args: Record<string, unknown>, ctx: ExtensionToolContext): Promise<ToolResult> | ToolResult;
}

/** A zone's extension: what `extension.ts` exports as `default`. */
export interface CodegraphExtension {
  /** The zone that owns it, e.g. `'queries'`. Used in warnings. */
  name: string;
  /** Synchronous; adds `program.command(...)` entries to the CLI. */
  registerCommands?(program: Command): void;
  /**
   * MCP tools. Off by default: a session LISTS one only when its own
   * CODEGRAPH_MCP_TOOLS (the one its launcher was started with) names it. With no
   * allowlist, a call by name is still served, as it is for a built-in.
   */
  tools?: ExtensionTool[];
}
