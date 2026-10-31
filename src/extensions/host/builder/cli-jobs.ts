/**
 * The index writes of the codegraph CLI (`init`, `index`, `sync`, the `--fresh` wait) as jobs of the builder's
 * queue (./queue.ts), so that while a machine server's index builder is up, these commands never open a database
 * for writing: the builder does every write. With no such builder, the CLI writes in its own process. The server relays the CLI's request over the builder IPC
 * (`cliIndex`, `cliSync`, ./protocol.ts); the wire to the CLI is ./cli-wire.ts.
 *
 * `cliIndex` has four modes, each one job:
 *   init            `CodeGraph.init(root, {index:false})`, an `initialized` event, `indexAll` with progress
 *                   events, close. An `init` job (COLD class). It takes no `rebuild.pid` and registers nothing in
 *                   the project registry, as `codegraph init` does in its own process; a cold build
 *                   (../worktree-lifecycle/cold-build.ts) takes both, for a root nobody asked for.
 *   rebuild         `codegraph index`: needs the root's lease (./fences.ts, `fence` request, which holds
 *                   `rebuild.pid`). Lets go of the root if the builder holds it, takes `writer.pid` for the lease,
 *                   recreates the database, `indexAll` with progress events, close. An `index` job (COLD class).
 *   reindex-leased  `indexAll` again on a writable open that the job closes when it ends, under the same lease
 *                   (the interactive re-run of `index`): needs the lease, takes no writer lock. An `index` job.
 *   reindex         `indexAll` on an existing index with no lease (the re-run of `init`): the writable open the
 *                   CLI would do. An `index` job.
 * The locks of a lease stay until it ends (`unfence`), through every job the CLI sends under it.
 * Every mode refuses at job start while the root is fenced for its removal (a `release` fence, `codegraph uninit`:
 * ./fences.ts `refuseIfRemoving`), so no job of these opens a database that is being deleted.
 *
 * `cliSync` is one `sync` job (SYNC class): through the hold's own graph when the builder holds the root and
 * owns its `writer.pid`, otherwise a writable open of the root for the one sync. It answers the whole SyncResult.
 * Under an `index` fence the fallback open checks nothing, as an in-process `codegraph sync` during another
 * process's rebuild checks neither `writer.pid` nor `rebuild.pid`; the queue is serial, so the sync runs between
 * a lease's jobs, never inside one. Under a `release` fence both branches refuse.
 *
 * Progress callbacks and abort signals never cross the IPC: a job (an index's or a sync's) turns the engine's
 * progress callback into `requestEvent` pushes (in order, one per callback, none dropped). A `verbose` index job
 * also turns the engine's console.log lines into `log` events, in the same order.
 */
import * as path from 'path';
import { format } from 'util';
import CodeGraph from '../../../index';
import type { IndexProgress, IndexResult, SyncResult } from '../../../extraction';
import { tryAcquireWriterLock, writerLockHeldMessage } from '../../../mcp/writer-lock';
import type { IndexWriteEvent } from './cli-wire';
import type { RebuildFences, RebuildLease } from './fences';
import type { HolderSet } from './holder';
import type { BuilderToServer, CliIndexMode } from './protocol';
import type { JobQueue } from './queue';

export interface CliJobDeps {
  queue: JobQueue;
  holders: HolderSet;
  fences: RebuildFences;
  /** Send a push to the server (the IPC channel). */
  send(message: BuilderToServer): void;
}

export class CliJobs {
  constructor(private readonly deps: CliJobDeps) {}

  /**
   * Run one `cliIndex` of `mode` on `root`. Resolves with the IndexResult once the job ended; rejects with its
   * error. `requestId` names the request the events are pushed for. A mode that needs the lease and finds none
   * (never taken, or ended) rejects before anything is queued; a lease job that waits in the queue past the end
   * of its lease refuses to run. A root fenced for its removal rejects every mode, when asked and again when the
   * job starts ("the index of <root> is being removed").
   */
  cliIndex(requestId: number, root: string, mode: CliIndexMode, verbose = false): Promise<IndexResult> {
    try {
      requireAbsoluteRoot(root);
      this.deps.fences.refuseIfRemoving(root);
      const emit = (event: IndexWriteEvent): void => this.deps.send({ op: 'requestEvent', requestId, event });
      const onProgress = (progress: IndexProgress): void => emit({ kind: 'progress', progress });
      // A verbose job runs with the builder's console.log turned into `log` events (see capturingLog).
      // Every job first asks again whether the root is being removed: the fence may have come while it waited.
      const checked = <T>(job: () => Promise<T>): (() => Promise<T>) => () => {
        this.deps.fences.refuseIfRemoving(root);
        return job();
      };
      const run = <T>(job: () => Promise<T>): (() => Promise<T>) => (verbose ? () => capturingLog(emit, checked(job)) : checked(job));
      const engine = { onProgress, verbose };
      switch (mode) {
        case 'init':
          return this.deps.queue.enqueue('init', root, run(() => this.init(root, emit, engine)));
        case 'reindex':
          return this.deps.queue.enqueue('index', root, run(() => this.reindex(root, engine)));
        case 'rebuild':
          return this.underLease(root, (lease) => run(() => this.rebuild(lease, engine))());
        case 'reindex-leased':
          return this.underLease(root, (lease) => run(() => {
            lease.assertLive();
            return this.reindex(root, engine);
          })());
        default:
          throw new Error(`unknown index mode: ${String(mode)}`);
      }
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * One sync of `root` as a `sync` job; the whole SyncResult. The sync's progress goes out as `requestEvent`
   * pushes for `requestId`, as an index's does, so the CLI renders the same phase lines as an in-process sync.
   * Rejects, when asked and again when the job starts, for a root fenced for its removal.
   */
  cliSync(requestId: number, root: string): Promise<SyncResult> {
    try {
      requireAbsoluteRoot(root);
      this.deps.fences.refuseIfRemoving(root);
    } catch (err) {
      return Promise.reject(err);
    }
    const onProgress = (progress: IndexProgress): void => this.deps.send({ op: 'requestEvent', requestId, event: { kind: 'progress', progress } });
    return this.deps.queue.enqueue('sync', root, async () => {
      // A removal fenced the root while the job waited: neither the hold nor a fresh open may be used.
      this.deps.fences.refuseIfRemoving(root);
      // Asked when the job runs: a hold the builder let go of while the job waited is not used.
      const held = this.deps.holders.ownedGraph(root);
      if (held) return held.sync({ onProgress });
      // No other fence check here: this matches an in-process `codegraph sync` while another process rebuilds (sync
      // looks at neither writer.pid nor rebuild.pid), and the serial queue keeps it out of a lease's jobs.
      const cg = await CodeGraph.open(root);
      try {
        return await cg.sync({ onProgress });
      } finally {
        cg.close();
      }
    });
  }

  /**
   * Queue an `index` job that needs the lease of `root`, and add it to the lease so `unfence` waits for it.
   * The lease is looked up now (no lease: rejected) and checked again when the job starts (`run` asserts it).
   * What is tracked is the promise the request answers with, so `unfence` answers after the job's own reply.
   */
  private underLease(root: string, run: (lease: RebuildLease) => Promise<IndexResult>): Promise<IndexResult> {
    const lease = this.deps.fences.requireLive(root);
    const job = this.deps.queue.enqueue('index', root, () => run(lease));
    lease.track(job);
    return job;
  }

  private async init(root: string, emit: (event: IndexWriteEvent) => void, engine: IndexEngineOptions): Promise<IndexResult> {
    const cg = await CodeGraph.init(root, { index: false });
    try {
      emit({ kind: 'initialized' });
      return await cg.indexAll(engine);
    } finally {
      cg.close();
    }
  }

  private async rebuild(lease: RebuildLease, engine: IndexEngineOptions): Promise<IndexResult> {
    lease.assertLive();
    const root = lease.root;
    // The builder's own hold of the root (open database, watcher, writer.pid) goes first: the server released
    // its handle before it asked for this job, but a hold of the builder's may still be there: an `open` job
    // that ran after the fence refuses to open (holder.ts openWritable), leaving the hold entry. `recreate`
    // deletes the database files.
    await this.deps.holders.release(root);
    const writer = tryAcquireWriterLock(root, 'rebuild');
    if (writer.kind === 'taken') throw new Error(writerLockHeldMessage(writer.existing, writer.pidPath));
    lease.noteWriter();
    const cg = await CodeGraph.recreate(root);
    try {
      return await cg.indexAll(engine);
    } finally {
      cg.close();
    }
  }

  private async reindex(root: string, engine: IndexEngineOptions): Promise<IndexResult> {
    const cg = await CodeGraph.open(root);
    try {
      return await cg.indexAll(engine);
    } finally {
      cg.close();
    }
  }
}

/** What a job passes to indexAll: the progress callback, and `verbose` only when the CLI asked for it. */
interface IndexEngineOptions {
  onProgress: (progress: IndexProgress) => void;
  verbose: boolean;
}

/**
 * Run `job` with console.log turned into `log` events, and put console.log back when it ends, whatever
 * way. With `verbose` the engine writes its `[worker] ...` and `[wal-valve] ...` diagnostics with console.log
 * (src/extraction/index.ts, src/index.ts), which a CLI running the index itself shows on its stdout; here the
 * lines go to the CLI as events, in order with the progress events. The builder's stdout is not connected
 * to anything (the server forks it with stdio 'ignore', ./client.ts), and the queue runs one job at a time,
 * so the lines logged while a job runs are that job's.
 */
async function capturingLog<T>(emit: (event: IndexWriteEvent) => void, job: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = (...args: unknown[]): void => emit({ kind: 'log', line: format(...args) });
  try {
    return await job();
  } finally {
    console.log = original;
  }
}

/** A root from the IPC must be an absolute path: a relative one would mean this process's working directory. */
export function requireAbsoluteRoot(root: unknown): string {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error(`the root must be an absolute path: ${String(root)}`);
  return root;
}
