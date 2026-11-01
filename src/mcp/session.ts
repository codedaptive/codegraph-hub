/**
 * MCP per-connection session — speaks the JSON-RPC protocol (initialize,
 * tools/list, tools/call) over a single {@link JsonRpcTransport}. It owns
 * per-client state only (the client's clientInfo, the repo anchor of its
 * launch directory, and its focus and tool allowlist, which are the client's
 * own; a legacy client whose hello carries no tool list falls back to the server
 * process's CODEGRAPH_MCP_TOOLS); the heavyweight resources (CodeGraph handles, ToolHandler)
 * live in the shared {@link MCPEngine}, and the watchers live in the index
 * builder, so the machine server holds one set of handles for all its sessions.
 *
 * A session has no default project: every tool call names its `projectPath`
 * and goes through {@link dispatchToolCall} (tool-name checks, required
 * projectPath, repo anchor, index admission, the session's tool allowlist) before the engine's handler runs it. The engine is never initialized by the handshake.
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
import type { SessionToolList } from '../extensions/host/server/session-scope';
import { getTelemetry, ClientInfo } from '../telemetry';
import { getUpdateNotice } from '../upgrade/update-check';
import { ExploreSessionState } from './explore-session-state';
import { CliRelay } from '../extensions/host/builder/cli-relay';
import { INDEX_WRITE_END_METHOD, INDEX_WRITE_METHOD } from '../extensions/host/builder/cli-wire';
import { IndexVersionWarningState } from './index-version-warning';

/**
 * The site's favicon on a light tile: the bare mark is dark ink on nothing,
 * which a dark UI loses. Written out rather than as base64 so a reader can see
 * it is two lines of shapes and nothing else.
 */
const SERVER_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="#16150f" stroke-width="2">' +
  '<rect width="32" height="32" rx="6" fill="#f7f6f2" stroke="none"/>' +
  '<line x1="16" y1="8" x2="8" y2="23"/><line x1="16" y1="8" x2="24" y2="23"/><line x1="8" y1="23" x2="24" y2="23"/>' +
  '<circle cx="16" cy="8" r="3.4" fill="#16150f"/><circle cx="8" cy="23" r="3.4" fill="#f7f6f2"/><circle cx="24" cy="23" r="3.4" fill="#f7f6f2"/>' +
  '</svg>';

/**
 * MCP Server Info — kept on the session because some clients log it. The
 * version tracks the real package version (was a hard-coded '0.1.0').
 *
 * `title` and `icons` are what a host may show in place of `name`. They are
 * newer than the protocol version this server claims, so a host that doesn't
 * know them passes over them. The icon has no `sizes`: it is optional and says
 * nothing about an SVG, and a host on an SDK that typed it as a string, as 1.18
 * did, would fail the whole handshake on the array the spec settled on.
 */
// Exported so the proxy can answer `initialize` locally with the IDENTICAL
// payload the machine server would send — no drift between the two handshake paths.
export const SERVER_INFO = {
  name: 'codegraph',
  title: 'CodeGraph',
  version: CodeGraphPackageVersion,
  icons: [
    {
      src: `data:image/svg+xml;base64,${Buffer.from(SERVER_ICON_SVG).toString('base64')}`,
      mimeType: 'image/svg+xml',
    },
  ],
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
  /**
   * The session's focus: directories relative to the repository root
   * (`sessionFocusEntries`) that search and explore results stay inside, in
   * every worktree of the repository; `[]` or omitted for none. It
   * reaches every tool call as an internal argument (see `dispatchToolCall`).
   */
  focus?: readonly string[];
  /**
   * The session's tool allowlist, which decides what `tools/list` shows and
   * what a call may run ({@link SessionToolList}): an array of short names,
   * null when the session was told it has none, undefined when it was never
   * told (a legacy client's hello), which falls back to the server process's
   * own CODEGRAPH_MCP_TOOLS.
   */
  toolAllowlist?: SessionToolList;
  /**
   * Whether this connection sent the control-client hello (the `control: 1` marker and no `launchDir`; the
   * daemon decides, from `ClientPeers`). Only such a connection may send `codegraph/indexWrite` /
   * `codegraph/indexWriteEnd`; every other session (an agent's proxy, a legacy client with no hello, a
   * direct-mode stdio session) is refused. Absent means false. The hello is a protocol shape, not an
   * identity: any process of this user can send it.
   */
  controlClient?: boolean;
}

/**
 * One MCP client's view of the server. Created fresh per stdio launch
 * (direct mode) or per socket connection (machine server).
 */
export class MCPSession {
  /** From the initialize handshake — attributes usage rollups to the agent host. */
  private clientInfo: ClientInfo | undefined;
  private readonly anchor: RepoAnchor | null;
  private readonly focus: readonly string[];
  private readonly toolAllowlist: SessionToolList;
  private readonly controlClient: boolean;
  /**
   * The relay of this connection's CLI index writes (`codegraph/indexWrite`): holds the index leases the
   * connection took, which {@link releaseLeases} lets go of when the connection goes.
   */
  private readonly cliRelay: CliRelay;
  /**
   * What `codegraph_explore` has already returned to THIS client, per project
   * (CG-17). Owned by the session, not the engine: the machine server shares one engine
   * (and one ToolHandler, and a pool of worker threads) across every connected
   * client, so state kept over there would blend two agents' histories and let
   * one session's calls suppress source the other has never seen. It dies with
   * the session — a reconnecting client starts clean.
   */
  private readonly exploreSession = new ExploreSessionState();
  /** One-time stale-index warnings already delivered to this MCP client. */
  private readonly indexVersionWarnings = new IndexVersionWarningState();

  constructor(
    private transport: JsonRpcTransport,
    private engine: MCPEngine,
    opts: MCPSessionOptions,
  ) {
    this.anchor = opts.anchor;
    this.focus = opts.focus ?? [];
    this.toolAllowlist = opts.toolAllowlist;
    this.controlClient = opts.controlClient === true;
    this.cliRelay = new CliRelay(transport, engine);
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

  /**
   * Let go of the index leases this connection holds (a `codegraph/indexWrite` `index` or `release` that was
   * not ended by `codegraph/indexWriteEnd`). The daemon calls it when the connection's client is dropped, on a peer
   * close and on the reaper's stop; the transport's own stop skips close handlers, so the close handler
   * alone is not enough. Fire-and-forget: the builder answers once the lease's jobs have settled. Never
   * throws.
   */
  releaseLeases(): void {
    this.cliRelay.releaseLeases();
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
        // server's own control surface (the release the in-process `codegraph index`
        // requests when no builder serves it), which names the root it wants closed
        // and may be any project the server holds.
        if (isRequest) await this.handleReleaseProject(message as JsonRpcRequest);
        break;
      case INDEX_WRITE_METHOD:
      case INDEX_WRITE_END_METHOD:
        // The codegraph CLI's index writes, relayed to the index builder (cli-relay.ts). Control surface
        // like releaseProject, so outside the repo anchor, and for control clients alone: an agent's
        // session could otherwise start a rebuild of any directory it names.
        if (isRequest) await this.handleIndexWrite(message as JsonRpcRequest);
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
    // every client (its focus and tool list included: the text describes the
    // focus argument and section for every session, whether or not it has one)
    // and the engine initializes nothing here. rootUri,
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
    // marks `projectPath` required on every tool. The list is THIS session's:
    // its own allowlist. Only a legacy client that was never told one gets the
    // server process's CODEGRAPH_MCP_TOOLS.
    this.transport.sendResult(request.id, {
      tools: this.engine.getToolHandler().getTools({ allowlist: this.toolAllowlist }),
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
      focus: this.focus,
      toolAllowlist: this.toolAllowlist,
      indexVersionWarnings: this.indexVersionWarnings,
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
   * `codegraph/indexWrite` and `codegraph/indexWriteEnd`: refused unless this is the CLI's control
   * connection; otherwise relayed to the index builder by the {@link CliRelay}, which answers the request.
   */
  private async handleIndexWrite(request: JsonRpcRequest): Promise<void> {
    if (!this.controlClient) {
      this.transport.sendError(request.id, ErrorCodes.InvalidRequest, `${request.method} is only for the codegraph CLI`);
      return;
    }
    if (request.method === INDEX_WRITE_END_METHOD) await this.cliRelay.handleIndexWriteEnd(request);
    else await this.cliRelay.handleIndexWrite(request);
  }

  /**
   * `codegraph/releaseProject {root}`: close the server's handle on one project
   * and have the builder drop its hold (its watcher and writer lock), so a CLI
   * that wants to take its writer lock can. 'released' is answered only after
   * the builder has let go (`releaseProjectRoot` awaits it). The root names a project
   * the server may hold for any session, so it is not checked against this
   * session's anchor. An in-process `codegraph index` sends it when no builder
   * serves the write; with a builder, `codegraph/indexWrite` is the route. The in-process `codegraph uninit`
   * sends it for the same reason, before it deletes the index (with a builder, the `release` op of
   * `codegraph/indexWrite` is its route).
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
