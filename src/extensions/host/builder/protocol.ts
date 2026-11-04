/**
 * The IPC messages between the server's {@link BuilderClient} (./client.ts) and the builder process
 * (./main.ts, ./service.ts). Plain JSON objects over the `child_process.fork` channel.
 *
 * A request carries `{ id, op, ...args }` and gets exactly one reply `{ id, ok, result | error }`. The builder
 * also pushes messages nobody asked for: `ready` once when it can take requests, `freshness` whenever a held
 * root's watcher state or pending set changes, `released` when the builder itself let a root go (its index
 * was removed), and `requestEvent` while a `cliIndex` or `cliSync` runs.
 *
 * The `fence`, `unfence`, `drain`, `cliIndex` and `cliSync` requests carry the codegraph CLI's index writes through
 * the server (./cli-wire.ts is the CLI's side of that route, ./cli-jobs.ts the builder's jobs, ./fences.ts the
 * rebuild lease). A `requestEvent` push belongs to the request whose id it names and has no `id` of its own,
 * so it is never taken for a reply ({@link isReply}).
 */
import type { BuilderFreshness } from './client';
import type { IndexWriteEvent } from './cli-wire';
import type { FenceKind } from './fences';

/** How a `cliIndex` writes: see ./cli-jobs.ts. */
export type CliIndexMode = 'init' | 'rebuild' | 'reindex' | 'reindex-leased';

export type BuilderRequest =
  /** `anchorRoot`: the session anchor's root, present when the call came with one (see BuilderClient.ensure). IPC data, not trusted: the builder checks it. */
  | { id: number; op: 'ensure'; projectPath: string; anchorRoot?: string }
  | { id: number; op: 'caughtUp'; root: string }
  | { id: number; op: 'sync'; root: string }
  | { id: number; op: 'release'; root: string }
  /**
   * Take the rebuild lease of `root` (rebuild.pid), or refuse when a rebuild already holds it. Answered at once.
   * `kind` (default `index`): `release` is an `uninit`'s fence, under which no job of the builder opens the root
   * (jobs that would refuse with "the index of <root> is being removed"); see ./fences.ts.
   */
  | { id: number; op: 'fence'; root: string; kind?: FenceKind }
  /** Answers once no job of `root` runs or waits on the builder's queue (at once when none does); other roots' jobs are not waited for. */
  | { id: number; op: 'drain'; root: string }
  /** End the lease: waits for its jobs, then releases its locks. Answers ok once the lease's jobs have settled and its locks are released; rejects only for a root that is not absolute. */
  | { id: number; op: 'unfence'; root: string }
  /** One `init`, `rebuild` (the CLI's `index`), `reindex` or `reindex-leased` of the codegraph CLI as a job; its events come back as `requestEvent` pushes. `verbose`: run indexAll verbose and send the job's console.log lines as `log` events. */
  | { id: number; op: 'cliIndex'; root: string; mode: CliIndexMode; verbose?: boolean }
  /** One sync of `root` as a job, answering the whole SyncResult. */
  | { id: number; op: 'cliSync'; root: string };

export type BuilderReply =
  | { id: number; ok: true; result: unknown }
  /** `errorName` is the error's class name: the client rebuilds a LockUnavailableError from it and names any other error by it. */
  | { id: number; ok: false; error: string; errorName?: string };

export type BuilderPush =
  | { op: 'ready'; pid: number }
  | { op: 'freshness'; state: BuilderFreshness }
  | { op: 'released'; root: string }
  /** An event of the running `cliIndex` or `cliSync` request `requestId`, in the order the job produced them. */
  | { op: 'requestEvent'; requestId: number; event: IndexWriteEvent };

export type BuilderToServer = BuilderReply | BuilderPush;

/** A message from the builder that is a reply (it has an `id`), not a push. */
export function isReply(message: BuilderToServer): message is BuilderReply {
  return typeof (message as { id?: unknown }).id === 'number';
}
