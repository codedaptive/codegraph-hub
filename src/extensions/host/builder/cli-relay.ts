/**
 * The server's half of the CLI's index writes: relays `codegraph/indexWrite` and `codegraph/indexWriteEnd`
 * (wire: ./cli-wire.ts) from one control connection to the index builder, which runs the write as a job on
 * its queue (./cli-jobs.ts). The CLI's side is ./cli-route.ts.
 *
 * The server never opens a database writable and never takes a lock here: every request is a builder
 * request. What the relay owns is the part that must happen in the server and nowhere else:
 *
 *  - the refusals, answered BEFORE any fence or job and worded as the CLI words them (the CLI checks the
 *    same things first; this is the server's own check, because any process of this user can connect to the socket);
 *  - for `index`, the order that lets the builder take the root: the builder fences the root (rebuild.pid, so
 *    no hold, seed or cold build of its own touches it), then the engine lets go of its read handles and the
 *    builder's hold (`releaseProjectRoot`), then the builder rebuilds;
 *  - the lease of that fence, which belongs to the connection: it ends on `codegraph/indexWriteEnd` or when
 *    the connection goes ({@link CliRelay.releaseLeases}, called by the daemon when it drops a client: on
 *    the peer's close, or when its reaper stops a dead peer), so a CLI that dies mid-index never leaves a root fenced;
 *  - forwarding the builder's progress events to the connection in order, unthrottled.
 *
 * Only a control client (a client hello with the `codegraph_client` and `control` markers and no `launchDir`) may use
 * these methods; the session enforces that before it reaches the relay.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { IndexResult, SyncResult } from '../../../extraction';
import { canonicalProjectRoot, isInitialized, unsafeIndexRootReason } from '../../../directory';
import { ErrorCodes, type JsonRpcRequest, type JsonRpcTransport } from '../../../mcp/transport';
import type { CliIndexMode } from './protocol';
import {
  INDEX_WRITE_EVENT_METHOD,
  type IndexWriteErrorData,
  type IndexWriteEvent,
  type IndexWriteEventParams,
  type IndexWriteOp,
  type IndexWriteParams,
  type IndexWriteResult,
} from './cli-wire';

/**
 * The builder surface the relay uses. `BuilderClient` (./client.ts) implements it; it is declared here, by
 * what the relay needs, so the relay is tested against a stand-in without forking a builder.
 */
export interface CliBuilder {
  /** The builder process is running and has said ready; no waiting. */
  isUp(): boolean;
  /** Take the root's rebuild fence; rejects with the refusal (e.g. 'Another index rebuild is already in progress.'). */
  fence(root: string): Promise<void>;
  /** Release the root's fence once its jobs have settled. Never rejects. */
  unfence(root: string): Promise<void>;
  /** Run one `init`, `rebuild` (the CLI's `index`), `reindex` or `reindex-leased` job, reporting its events in order; rejects with the job's error (name preserved). */
  cliIndex(root: string, mode: CliIndexMode, onEvent: (event: IndexWriteEvent) => void, verbose: boolean): Promise<IndexResult>;
  /** One sync job of the root at sync priority; `onEvent` receives the sync's progress events. */
  cliSync(root: string, onEvent: (event: IndexWriteEvent) => void): Promise<SyncResult>;
}

/** The engine surface the relay uses (MCPEngine implements it). */
export interface CliRelayEngine {
  /** The builder this engine's projects are written by; null for an engine without one. */
  getBuilder(): CliBuilder | null;
  /** Close the engine's handles on `root` (the tool handler's, the query pool's) and the builder's hold; resolves once done. */
  releaseProjectRoot(root: string): Promise<void>;
}

const OPS: readonly IndexWriteOp[] = ['init', 'index', 'reindex', 'sync'];

/** A request the relay answers with a JSON-RPC error: its code, text and the thrown error's class name. */
class RelayError extends Error {
  constructor(message: string, readonly code: number, readonly errorName?: string) {
    super(message);
  }
}

export class CliRelay {
  /**
   * The roots whose fence this connection holds, in their canonical spelling: set once `fence` resolved,
   * dropped by `indexWriteEnd`, a failed release, or {@link releaseLeases}.
   */
  private readonly leases = new Set<string>();
  /** The connection is gone: a fence that resolves after that is released at once instead of recorded. */
  private ended = false;

  constructor(
    private readonly transport: JsonRpcTransport,
    private readonly engine: CliRelayEngine,
  ) {}

  /** `codegraph/indexWrite`: answers the request with a result or a JSON-RPC error; never throws. */
  async handleIndexWrite(request: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.indexWrite(request.params);
      this.transport.sendResult(request.id, result);
    } catch (err) {
      this.replyError(request, err);
    }
  }

  /** `codegraph/indexWriteEnd {root}`: release this connection's lease on the root (a root it holds none on is not an error). */
  async handleIndexWriteEnd(request: JsonRpcRequest): Promise<void> {
    try {
      const root = (request.params as { root?: unknown } | undefined)?.root;
      if (typeof root !== 'string' || root.trim() === '') {
        throw new RelayError('Missing root', ErrorCodes.InvalidParams);
      }
      const canonical = resolveRoot(root);
      if (this.leases.delete(canonical)) {
        await this.engine.getBuilder()?.unfence(canonical);
      }
      this.transport.sendResult(request.id, { ended: true });
    } catch (err) {
      this.replyError(request, err);
    }
  }

  /**
   * Release every lease this connection holds, without waiting: the builder's `unfence` answers once the
   * lease's jobs have settled, which can be minutes, and neither the close handler nor the reaper may wait
   * on it. Never throws. The relay takes no further lease afterwards.
   */
  releaseLeases(): void {
    this.ended = true;
    const builder = this.engine.getBuilder();
    const roots = [...this.leases];
    this.leases.clear();
    if (!builder) return;
    for (const root of roots) {
      try {
        void builder.unfence(root).catch(() => { /* unfence never rejects; a stand-in that does must not escape */ });
      } catch { /* best-effort */ }
    }
  }

  private async indexWrite(rawParams: unknown): Promise<IndexWriteResult> {
    const params = parseParams(rawParams);
    const { op, force } = params;
    const verbose = params.verbose === true;
    const root = resolveRoot(params.root);
    refuse(op, root, force === true);

    const builder = this.engine.getBuilder();
    if (!builder) return { routed: false, reason: 'the server has no index builder' };
    if (!builder.isUp()) return { routed: false, reason: 'the index builder is not running' };

    const onEvent = (event: IndexWriteEvent): void => {
      const eventParams: IndexWriteEventParams = { event };
      try { this.transport.notify(INDEX_WRITE_EVENT_METHOD, eventParams); } catch { /* connection gone: the job still finishes */ }
    };

    switch (op) {
      case 'sync':
        return { routed: true, result: await builder.cliSync(root, onEvent) };
      case 'init':
        return { routed: true, result: await builder.cliIndex(root, 'init', onEvent, verbose) };
      case 'reindex':
        // Under this connection's lease when it holds one for the root (the interactive re-run of `index`),
        // else on the index as it stands (the re-run of `init`).
        return { routed: true, result: await builder.cliIndex(root, this.leases.has(root) ? 'reindex-leased' : 'reindex', onEvent, verbose) };
      case 'index': {
        // (1) fence: the builder refuses when another rebuild runs. Jobs already queued on the root may still run
        // before the release in (2), which waits for any running one. A refusal here took no lease, so there is
        // nothing to release.
        await builder.fence(root);
        if (this.ended) {
          await builder.unfence(root);
          throw new RelayError('the connection closed before the index write started', ErrorCodes.InternalError);
        }
        this.leases.add(root);
        // (2) the engine's handles and the builder's hold on the root go, so the rebuild can take the writer lock.
        try {
          await this.engine.releaseProjectRoot(root);
        } catch (err) {
          this.leases.delete(root);
          await builder.unfence(root);
          throw err;
        }
        // (3) rebuild. The lease stays after it (also after a failure) until indexWriteEnd or the connection's end.
        return { routed: true, result: await builder.cliIndex(root, 'rebuild', onEvent, verbose) };
      }
    }
  }

  private replyError(request: JsonRpcRequest, err: unknown): void {
    if (err instanceof RelayError) {
      const data: IndexWriteErrorData | undefined = err.errorName ? { errorName: err.errorName } : undefined;
      this.transport.sendError(request.id, err.code, err.message, data);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    // The class name rides along so the CLI can match a LockUnavailableError by name (src/extensions/host/fresh/checkpoint.ts); a held rebuild lock arrives as a plain Error.
    const errorName = err instanceof Error ? err.name : undefined;
    const data: IndexWriteErrorData | undefined = errorName ? { errorName } : undefined;
    this.transport.sendError(request.id, ErrorCodes.InternalError, message, data);
  }
}

function parseParams(raw: unknown): IndexWriteParams {
  const p = (raw ?? {}) as { op?: unknown; root?: unknown; force?: unknown; verbose?: unknown };
  if (typeof p.op !== 'string' || !OPS.includes(p.op as IndexWriteOp)) {
    throw new RelayError(`Unknown op: ${String(p.op)}`, ErrorCodes.InvalidParams);
  }
  if (typeof p.root !== 'string' || p.root.trim() === '') {
    throw new RelayError('Missing root', ErrorCodes.InvalidParams);
  }
  if (!path.isAbsolute(p.root)) {
    throw new RelayError(`The root must be an absolute path: ${p.root}`, ErrorCodes.InvalidParams);
  }
  return { op: p.op as IndexWriteOp, root: p.root, force: p.force === true, verbose: p.verbose === true };
}

/**
 * The root's spelling every later step uses: the realpath of a root that exists (a symlinked checkout and its
 * target are one index), the normalised absolute path of one that does not yet (`init` creates it).
 */
function resolveRoot(root: string): string {
  const resolved = path.resolve(root);
  return fs.existsSync(resolved) ? canonicalProjectRoot(resolved) : resolved;
}

/**
 * The CLI's own refusals (src/bin/codegraph.ts: runInit and the `index`, `sync` commands), no more:
 * `init` and `index` refuse an unsafe root unless forced (a root that does not exist yet passes: init
 * creates it); `init` refuses an initialized root, the others an uninitialized one.
 */
function refuse(op: IndexWriteOp, root: string, force: boolean): void {
  if ((op === 'init' || op === 'index') && !force) {
    const unsafe = unsafeIndexRootReason(root);
    if (unsafe) {
      throw new RelayError(
        op === 'init'
          ? `Refusing to initialize in ${root} — it looks like ${unsafe}.`
          : `Refusing to index ${root} — it looks like ${unsafe}. Pass --force to override.`,
        ErrorCodes.InvalidParams,
      );
    }
  }
  const initialized = isInitialized(root);
  if (op === 'init' && initialized) {
    throw new RelayError(`Already initialized in ${root}`, ErrorCodes.InvalidParams);
  }
  if (op !== 'init' && !initialized) {
    throw new RelayError(`CodeGraph not initialized in ${root}`, ErrorCodes.InvalidParams);
  }
}
