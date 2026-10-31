/**
 * MCP per-connection session — speaks the JSON-RPC protocol (initialize,
 * tools/list, tools/call) over a single {@link JsonRpcTransport}. It owns
 * per-client state only (the client's clientInfo and the repo anchor of its
 * launch directory); the heavyweight resources (CodeGraph handles, ToolHandler)
 * live in the shared {@link MCPEngine}, and the watchers live in the index
 * builder, so the machine server holds one set of handles for all its sessions.
 *
 * A session has no default project: every tool call names its `projectPath`
 * and goes through {@link dispatchToolCall} (tool-name checks, required
 * projectPath, repo anchor, index admission) before the engine's handler runs it. The engine is never initialized by the handshake.
 *
 * Speaks JSON-RPC for one MCP client; `__tests__/mcp-initialize.test.ts` drives
 * it end to end through `serve --mcp`.
 */

import { JsonRpcRequest, JsonRpcNotification, JsonRpcTransport, ErrorCodes } from './transport';
import { MCPEngine } from './engine';
import { SERVER_INSTRUCTIONS } from './server-instructions';
import { CodeGraphPackageVersion } from './version';
import type { RepoAnchor } from '../extensions/host/server/repo-anchor';
import { dispatchToolCall } from '../extensions/host/server/tool-call';
import { getTelemetry, ClientInfo } from '../telemetry';
import { getUpdateNotice } from '../upgrade/update-check';
import { ExploreSessionState } from './explore-session-state';

/**
 * MCP Server Info — kept on the session because some clients log it. The
 * version tracks the real package version (was a hard-coded '0.1.0').
 */
// Exported so the proxy can answer `initialize` locally with the IDENTICAL
// payload the machine server would send — no drift between the two handshake paths.
export const SERVER_INFO = {
  name: 'codegraph',
  version: CodeGraphPackageVersion,
};

/**
 * Instructions for the `initialize` response, with the update-availability
 * notice appended when one is known (#1243). Exported so the proxy's local
 * handshake sends the IDENTICAL payload — same convention as SERVER_INFO.
 * `getUpdateNotice` is a memoized synchronous cache read, so the #172
 * respond-fast contract holds; when no notice exists the instructions are
 * byte-identical to the bare constants.
 *
 * Test-authoring note: on a machine whose real `~/.codegraph` cache knows a
 * newer release, spawned servers append the notice — a test asserting exact
 * instructions equality must set `CODEGRAPH_NO_UPDATE_CHECK=1` in the spawn
 * env or it will fail only in the weeks after a release ships.
 */
export function initializeInstructions(base: string, notice: string | null = getUpdateNotice()): string {
  if (!notice) return base;
  return (
    `${base}\n\n---\n${notice} This server keeps running the old version until ` +
    `the user upgrades — mention it when convenient; do not run the upgrade yourself.`
  );
}

/** MCP Protocol Version (latest the server claims). */
export const PROTOCOL_VERSION = '2024-11-05';

export interface MCPSessionOptions {
  /**
   * The repository this session answers for, resolved from the directory the
   * client was launched in (`resolveRepoAnchor`). Null when the client reported
   * no launch directory: every tool call is then answered with guidance to
   * restart the session, never with a guess from the server's own cwd.
   */
  anchor: RepoAnchor | null;
}

/**
 * One MCP client's view of the server. Created fresh per stdio launch
 * (direct mode) or per socket connection (machine server).
 */
export class MCPSession {
  /** From the initialize handshake — attributes usage rollups to the agent host. */
  private clientInfo: ClientInfo | undefined;
  private readonly anchor: RepoAnchor | null;
  /**
   * What `codegraph_explore` has already returned to THIS client, per project
   * (CG-17). Owned by the session, not the engine: the machine server shares one engine
   * (and one ToolHandler, and a pool of worker threads) across every connected
   * client, so state kept over there would blend two agents' histories and let
   * one session's calls suppress source the other has never seen. It dies with
   * the session — a reconnecting client starts clean.
   */
  private readonly exploreSession = new ExploreSessionState();

  constructor(
    private transport: JsonRpcTransport,
    private engine: MCPEngine,
    opts: MCPSessionOptions,
  ) {
    this.anchor = opts.anchor;
  }

  /**
   * Start handling messages from the transport. Returns immediately — the
   * session lives for as long as the transport is open.
   */
  start(): void {
    this.transport.start(this.handleMessage.bind(this));
  }

  /**
   * Tear down the session. Does NOT touch the engine (the engine may serve
   * other sessions) or call `process.exit` (the server process decides when to exit).
   */
  stop(): void {
    this.transport.stop();
  }

  /** Underlying transport — exposed for the server's close hooks. */
  getTransport(): JsonRpcTransport {
    return this.transport;
  }

  /**
   * This session's explore call history (CG-17). Exposed so tests can assert
   * that two sessions on one server keep separate state; nothing in the server
   * reaches for another session's copy.
   */
  getExploreSessionState(): ExploreSessionState {
    return this.exploreSession;
  }

  private async handleMessage(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    const isRequest = 'id' in message;
    switch (message.method) {
      case 'initialize':
        if (isRequest) await this.handleInitialize(message as JsonRpcRequest);
        break;
      case 'initialized':
        // Notification that client has finished initialization — no action needed.
        break;
      case 'tools/list':
        if (isRequest) await this.handleToolsList(message as JsonRpcRequest);
        break;
      case 'tools/call':
        if (isRequest) await this.handleToolsCall(message as JsonRpcRequest);
        break;
      case 'codegraph/releaseProject':
        // Not a tool call, so it sits outside the repo anchor: it is the
        // server's own control surface (the release `codegraph index` requests), which
        // names the root it wants closed and may be any project the server holds.
        if (isRequest) await this.handleReleaseProject(message as JsonRpcRequest);
        break;
      case 'ping':
        if (isRequest) this.transport.sendResult((message as JsonRpcRequest).id, {});
        break;
      case 'resources/list':
        // We expose no MCP resources, but some clients (opencode, Codex) probe
        // for them on connect; reply with an empty list instead of a
        // MethodNotFound error that surfaces as a scary `-32601` log line. (#621)
        if (isRequest) this.transport.sendResult((message as JsonRpcRequest).id, { resources: [] });
        break;
      case 'resources/templates/list':
        if (isRequest) this.transport.sendResult((message as JsonRpcRequest).id, { resourceTemplates: [] });
        break;
      case 'prompts/list':
        // Likewise — no prompts exposed, but answer the probe cleanly. (#621)
        if (isRequest) this.transport.sendResult((message as JsonRpcRequest).id, { prompts: [] });
        break;
      default:
        if (isRequest) {
          this.transport.sendError(
            (message as JsonRpcRequest).id,
            ErrorCodes.MethodNotFound,
            `Method not found: ${message.method}`,
          );
        }
    }
  }

  private async handleInitialize(request: JsonRpcRequest): Promise<void> {
    const params = request.params as {
      clientInfo?: { name?: unknown; version?: unknown };
    } | undefined;

    if (params?.clientInfo) {
      this.clientInfo = {
        name: typeof params.clientInfo.name === 'string' ? params.clientInfo.name : undefined,
        version: typeof params.clientInfo.version === 'string' ? params.clientInfo.version : undefined,
      };
    }

    // The handshake resolves no root and opens nothing (#172 respond-fast): a
    // session has no default project, so the one instructions text applies to
    // every client and the engine initializes nothing here. rootUri,
    // workspaceFolders and roots/list are deliberately ignored; the launch
    // directory fixed the anchor when the session was created.
    this.transport.sendResult(request.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: initializeInstructions(SERVER_INSTRUCTIONS),
    });
  }

  private async handleToolsList(request: JsonRpcRequest): Promise<void> {
    // Always expose the tools: whether a project is indexed is not the list's
    // business. A call against an un-indexed path returns SUCCESS-shaped guidance, never
    // `isError`, so it can't teach the agent to abandon codegraph. `getTools()`
    // marks `projectPath` required on every tool.
    this.transport.sendResult(request.id, {
      tools: this.engine.getToolHandler().getTools(),
    });
  }

  private async handleToolsCall(request: JsonRpcRequest): Promise<void> {
    // Everything between the wire and the handler (tool-name checks, the
    // required-projectPath and repo-anchor guard, index admission) is
    // dispatchToolCall's, shared with the proxy's in-process fallback; this
    // method only replies and counts.
    const debug = !!process.env.CODEGRAPH_MCP_DEBUG;
    if (debug) process.stderr.write(`[mcp-debug] toolsCall id=${String(request.id)} dispatch\n`);
    const outcome = await dispatchToolCall({
      handler: this.engine.getToolHandler(),
      anchor: this.anchor,
      exploreSession: this.exploreSession,
      params: request.params,
    });
    if (debug) process.stderr.write(`[mcp-debug] toolsCall id=${String(request.id)} done\n`);
    if ('error' in outcome) {
      this.transport.sendError(request.id, outcome.error.code, outcome.error.message);
      return;
    }
    this.transport.sendResult(request.id, outcome.result);
    // After the reply is on the wire — telemetry must never delay a tool
    // response (in-memory increment only; see src/telemetry).
    getTelemetry().recordUsage('mcp_tool', outcome.toolName, !outcome.result.isError, this.clientInfo);
  }

  /**
   * `codegraph/releaseProject {root}`: close the server's handle on one project
   * and have the builder drop its hold (its watcher and writer lock), so a CLI
   * that wants to take its writer lock can. 'released' is answered only after
   * the builder has let go (`releaseProjectRoot` awaits it). The root names a project
   * the server may hold for any session, so it is not checked against this
   * session's anchor.
   */
  private async handleReleaseProject(request: JsonRpcRequest): Promise<void> {
    const root = (request.params as { root?: unknown } | undefined)?.root;
    if (typeof root !== 'string' || root.trim() === '') {
      this.transport.sendError(request.id, ErrorCodes.InvalidParams, 'Missing root');
      return;
    }
    await this.engine.releaseProjectRoot(root);
    this.transport.sendResult(request.id, { released: true });
  }
}
