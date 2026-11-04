/**
 * The wire between a CLI command that writes an index (`init`, `index`, `sync`, the `--fresh` wait) or deletes one
 * (`uninit`) and the running machine server, which relays the write to its index builder. Types and names only: the CLI side
 * is ./cli-route.ts, the server side ./cli-relay.ts, the builder's jobs ./cli-jobs.ts.
 *
 * The CLI connects to the server's existing socket, reads the server hello, sends a client hello with the
 * `codegraph_client` and `control` markers and no `launchDir` (a control client, not an agent session), then requests on
 * that one connection:
 *
 *   → {"jsonrpc":"2.0","id":<n>,"method":"codegraph/indexWrite","params":IndexWriteParams}
 *   ← {"jsonrpc":"2.0","method":"codegraph/indexWriteEvent","params":IndexWriteEventParams}   (0..n, while it runs)
 *   ← {"jsonrpc":"2.0","id":<n>,"result":IndexWriteResult}
 *   ← {"jsonrpc":"2.0","id":<n>,"error":{"code","message","data":IndexWriteErrorData}}
 *
 * An `index` request leaves a lease on the connection: the builder keeps the root's `rebuild.pid` and
 * `writer.pid` until the CLI sends `codegraph/indexWriteEnd` or the connection goes away, so the
 * interactive re-run (`reindex`) runs under the same locks, as the in-process command holds them. A `release`
 * request (`uninit`) fences the root with a `release` fence and holds `rebuild.pid` only: no job runs for it, so no
 * `writer.pid` is taken. The server and the builder let go of its index and the builder drains the root's jobs
 * (the reply waits for them); until the lease ends the builder starts no job that opens the root. The CLI deletes
 * `.codegraph` before it ends the lease.
 *
 *   → {"jsonrpc":"2.0","id":<n>,"method":"codegraph/indexWriteEnd","params":{"root":<root>}}
 *   ← {"jsonrpc":"2.0","id":<n>,"result":{"ended":true}}
 */
import type { IndexProgress, IndexResult, SyncResult } from '../../../extraction';

export const INDEX_WRITE_METHOD = 'codegraph/indexWrite';
export const INDEX_WRITE_EVENT_METHOD = 'codegraph/indexWriteEvent';
export const INDEX_WRITE_END_METHOD = 'codegraph/indexWriteEnd';

/**
 * What the CLI asks for.
 *   init     CodeGraph.init(root, {index:false}) then indexAll; no rebuild.pid, no project registry.
 *   index    take the lease (rebuild.pid, then the server lets go of the root, then writer.pid), recreate, indexAll.
 *   reindex  indexAll on the existing index: under this connection's lease when it holds one for the root
 *            (index's interactive re-run), else with no lock but the engine's own (init's re-run).
 *   sync     one sync of the root, on the builder's queue at sync priority.
 *   release  `uninit`: take a `release` lease (rebuild.pid, then the server and the builder let go of the root,
 *            then the root's builder jobs drain), and stop there: nothing is rebuilt. The CLI then deletes
 *            `.codegraph` and ends the lease.
 * `force` is the CLI's --force: the unsafe-root refusal (unsafeIndexRootReason) is skipped for init/index.
 * `verbose` is the CLI's --verbose on init/index/reindex: the job runs indexAll({verbose: true}) and its
 * console output comes back as `log` events, so the CLI prints what an in-process run prints.
 * `root` is absolute; the server resolves its realpath.
 */
export type IndexWriteOp = 'init' | 'index' | 'reindex' | 'sync' | 'release';

export interface IndexWriteParams {
  op: IndexWriteOp;
  root: string;
  force?: boolean;
  verbose?: boolean;
}

/**
 * One event of a running init/index/reindex/sync, in order (a `release` sends none). `initialized` comes once, after CodeGraph.init
 * returned. `log` is one line the engine wrote with console.log during a `verbose` request (the `[worker] ...`
 * and `[wal-valve] ...` lines), in order with the progress events; the CLI prints it with console.log.
 */
export type IndexWriteEvent =
  | { kind: 'initialized' }
  | { kind: 'progress'; progress: IndexProgress }
  | { kind: 'log'; line: string };

export interface IndexWriteEventParams {
  event: IndexWriteEvent;
}

/** The answer to a `release`: the root is fenced against builder jobs, and neither the server nor the builder holds its index or runs a job on it. */
export interface ReleaseResult {
  released: true;
}

/**
 * `routed: false`: nothing was taken or written (the server has no builder up); the CLI writes in its own
 * process. Never sent once the lease or a job exists.
 * `routed: true`: the builder ran the job, or for `release` fenced the root and let it go; `result` is the
 * IndexResult (init/index/reindex), SyncResult (sync) or
 * ReleaseResult (release).
 */
export type IndexWriteResult =
  | { routed: false; reason: string }
  | { routed: true; result: IndexResult | SyncResult | ReleaseResult };

/** The JSON-RPC error's `data`: the thrown error's class name, so the CLI can match e.g. a LockUnavailableError by name. */
export interface IndexWriteErrorData {
  errorName?: string;
}
