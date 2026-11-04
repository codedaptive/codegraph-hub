/**
 * The one dispatch of an MCP `tools/call`.
 *
 * A call reaches a ToolHandler from two places: the machine server's session
 * (`MCPSession.handleToolsCall`) and the proxy's in-process fallback while the
 * server is unreachable (`runLocalHandshakeProxy`). {@link dispatchToolCall} is
 * the single copy of the sequence below and the only place outside the CLI that
 * calls `ToolHandler.execute`, so both callers apply the
 * same rules in the same order and neither can skip one: a missing tool name and
 * an unknown tool are refused before the repo guard, so the handler never opens a
 * project or runs the `fresh` sync for a call that was going to be refused, and
 * the index's admission is supplied here, not left to each caller.
 *
 * The sequence, each step before anything is opened:
 *  1. a missing or blank tool name -> InvalidParams;
 *  2. `arguments` that are not an object (a string, number, boolean or array;
 *     missing, null or another falsy value mean none) -> InvalidParams
 *     ({@link TOOL_ARGUMENTS_NOT_OBJECT}). It is a malformed request, the
 *     client's to fix, so it is never run: run, a string made the handler
 *     throw, which came back as an internal codegraph error to retry (#2981);
 *  3. a name that is neither a built-in nor a loaded extension's tool -> InvalidParams;
 *  4. {@link sessionCallGuard}: required `projectPath` inside the repo anchor,
 *     otherwise its success-shaped guidance;
 *  5. `execute` with the guard's absolute `projectPath` substituted, the
 *     session's {@link indexRootAdmission}, which `execute` insists on for an MCP
 *     engine's handler, the anchor's root, where the index builder cold-builds
 *     a path outside git that has no index, and the session's own tool
 *     allowlist, which decides whether the tool may be called at all.
 *
 * Two internal arguments carry the session's scope down to the handler
 * ({@link SESSION_FOCUS_ARG}, {@link SESSION_TOOLS_ARG}; see `./session-scope`).
 * Both are stripped from the call's wire arguments first, for every tool, so a
 * client cannot set them. The focus argument is then always set from the
 * session's own record (`[]` for a session with no focus); the allowlist argument
 * only when the session was told one (a legacy client's call carries the focus
 * argument but not the allowlist one, and the handler reads its own
 * CODEGRAPH_MCP_TOOLS).
 *
 * The callers keep what differs between them: the transport reply and telemetry
 * (counted only for a known tool, which is every `result` outcome).
 */
import { ErrorCodes } from '../../../mcp/transport';
import { isKnownTool, type ToolHandler, type ToolResult } from '../../../mcp/tools';
import type { ExploreSessionState } from '../../../mcp/explore-session-state';
import type { IndexVersionWarningState } from '../../../mcp/index-version-warning';
import { indexRootAdmission, sessionCallGuard, type RepoAnchor } from './repo-anchor';
import {
  SESSION_FOCUS_ARG,
  SESSION_TOOLS_ARG,
  withoutSessionArgs,
  type SessionToolList,
} from './session-scope';

/** The invalid-params message for a `tools/call` whose `arguments` are not an object. */
export const TOOL_ARGUMENTS_NOT_OBJECT = 'Tool arguments must be an object';

/** What one `tools/call` came to: the tool's answer, or a JSON-RPC error to reply with. */
export type ToolCallOutcome =
  | {
    /** The known tool the call named, for the caller's telemetry. */
    toolName: string;
    result: ToolResult;
  }
  | { error: { code: number; message: string } };

export interface ToolCallInput {
  /** The engine's handler. */
  handler: ToolHandler;
  /** The session's repo anchor; null when the client reported no launch directory. */
  anchor: RepoAnchor | null;
  /** The calling session's explore history (CG-17); omitted when the caller keeps none. */
  exploreSession?: ExploreSessionState;
  /**
   * The calling client's one-time stale-index warnings (`IndexVersionWarningState`);
   * omitted when the caller keeps none, and no warning is then added.
   */
  indexVersionWarnings?: IndexVersionWarningState;
  /**
   * The session's focus: normalised directories relative to the repository root
   * (`sessionFocusEntries`), `[]` or omitted for a session with none.
   */
  focus?: readonly string[];
  /**
   * The session's tool allowlist ({@link SessionToolList}): an array of short
   * names, null for a session told it has none, undefined (or omitted) for a
   * session never told one, which falls back to the handler's own
   * CODEGRAPH_MCP_TOOLS.
   */
  toolAllowlist?: SessionToolList;
  /** The request's `params`, exactly as received: nothing about it is trusted. */
  params: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Run one `tools/call` (see the file comment). Never opens, seeds, watches or
 * syncs anything for a call it turns down. May reject only for a fault the guard
 * or the handler could not express as an answer; the caller maps that to a
 * JSON-RPC internal error.
 */
export async function dispatchToolCall(call: ToolCallInput): Promise<ToolCallOutcome> {
  const params = isRecord(call.params) ? call.params : undefined;
  const toolName = params?.name;
  if (typeof toolName !== 'string' || toolName.trim() === '') {
    return { error: { code: ErrorCodes.InvalidParams, message: 'Missing tool name' } };
  }
  const rawArgs = params?.arguments || {};
  if (!isRecord(rawArgs)) {
    return { error: { code: ErrorCodes.InvalidParams, message: TOOL_ARGUMENTS_NOT_OBJECT } };
  }
  if (!isKnownTool(toolName)) {
    return { error: { code: ErrorCodes.InvalidParams, message: `Unknown tool: ${toolName}` } };
  }

  // Strip first: the keys are the session's to set, never the wire's.
  const args = withoutSessionArgs(rawArgs);
  const guarded = await sessionCallGuard(args, call.anchor);
  if ('answer' in guarded) return { toolName, result: guarded.answer };

  // The guard returns a path only for a non-null anchor, so `call.anchor` is set.
  const sessionArgs: Record<string, unknown> = {
    ...args,
    projectPath: guarded.projectPath,
    [SESSION_FOCUS_ARG]: [...(call.focus ?? [])],
  };
  if (call.toolAllowlist !== undefined) {
    sessionArgs[SESSION_TOOLS_ARG] = call.toolAllowlist === null ? null : [...call.toolAllowlist];
  }
  const result = await call.handler.execute(
    toolName,
    sessionArgs,
    call.exploreSession,
    {
      admitIndexRoot: indexRootAdmission(call.anchor!),
      anchorRoot: call.anchor!.root,
      toolAllowlist: call.toolAllowlist,
      indexVersionWarnings: call.indexVersionWarnings,
    },
  );
  return { toolName, result };
}
