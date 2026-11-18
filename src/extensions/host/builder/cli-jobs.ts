/**
 * The index writes of the codegraph CLI (`init`, `index`, `sync`, the `--fresh` wait) as jobs of the builder's
 * queue (./queue.ts), so that while a machine server's index builder is up, these commands never open a database
 * for writing: the builder does every write. With no such builder, the CLI writes in its own process. The server relays the CLI's request over the builder IPC
 * (`cliIndex`, `cliSync`, ./protocol.ts); the wire to the CLI is ./cli-wire.ts.
 *
 * Each job checks its fences and takes its locks here, in the builder, then runs its body through the
 * builder's job runner (./job-runner-type.ts: a child process per job), so a limit ends that job alone. The
 * bodies take no `writer.pid` or `rebuild.pid` of their own.
 *
 * `cliIndex` has four modes, each one job (./index-root-body.ts in the job's child):
 *   init            `CodeGraph.init(root, {index:false})`, an `initialized` event, `indexAll` with progress
 *                   events, close. An `init` job. It takes no `rebuild.pid` and registers nothing in
 *                   the project registry, as `codegraph init` does in its own process; a cold build
 *                   (../worktree-lifecycle/cold-build.ts) takes both, for a root nobody asked for.
 *   rebuild         `codegraph index`: needs the root's lease (./fences.ts, `fence` request, which holds
 *                   `rebuild.pid`). Lets go of the root if the builder holds it and takes `writer.pid` (mode
 *                   `rebuild`, the builder's pid) for the lease; the child recreates the database, runs
 *                   `indexAll` with progress events and closes. An `index` job.
 *   reindex-leased  `indexAll` again on a writable open that the job closes when it ends, under the same lease
 *                   (the interactive re-run of `index`): needs the lease, takes no writer lock. An `index` job.
 *   reindex         `indexAll` on an existing index with no lease (the re-run of `init`): the writable open the
 *                   CLI would do. An `index` job.
 * The locks of a lease stay until it ends (`unfence`), through every job the CLI sends under it.
 * Every mode, and `cliSync`, refuses a root in no git worktree before anything is queued (codegraph indexes only
 * git worktrees: `requireGitWorktreeRoot`'s refusal is the error). Every mode refuses at job start while the root
 * is fenced for its removal (a `release` fence, `codegraph uninit`:
 * ./fences.ts `refuseIfRemoving`), so no job of these opens a database that is being deleted.
 *
 * `cliSync` is one `sync` job (./sync-root-body.ts in the job's child): a writable open of the root for the one
 * sync. It answers the whole SyncResult. When the builder holds the root and owns its `writer.pid`, the sync runs
 * under that lock; the child takes none. Under an `index` fence the job checks nothing more, as an in-process
 * `codegraph sync` during another process's rebuild checks neither `writer.pid` nor `rebuild.pid`; the queue
 * never runs two jobs of one root together, so the sync runs between a lease's jobs, never inside one. Under a
 * `release` fence it refuses.
 *
 * Progress callbacks and abort signals never cross the IPC: the child sends the engine's progress as payloads,
 * and the builder turns them into `requestEvent` pushes (in order, one per callback, none dropped). A `verbose`
 * index job also sends the engine's console.log lines, which go out as `log` events in the same order
 * (./run-index-job.ts).
 */
import * as path from 'path';
import type { IndexResult, SyncResult } from '../../../extraction';
import { tryAcquireWriterLock, writerLockHeldMessage } from '../../../mcp/writer-lock';
import type { IndexWriteEvent } from './cli-wire';
import type { RebuildFences, RebuildLease } from './fences';
import type { HolderSet } from './holder';
import type { JobRunner } from './job-runner-type';
import type { BuilderToServer, CliIndexMode } from './protocol';
import { requireGitWorktreeRoot } from '../worktree-lifecycle/requireGitWorktreeRoot';
import type { JobQueue } from './queue';
import { runIndexJob } from './run-index-job';
import { runSyncJob } from './run-sync-job';

export interface CliJobDeps {
  queue: JobQueue;
  holders: HolderSet;
  fences: RebuildFences;
  /** Runs each job's body (the builder's runner: a child process per job). */
  runJob: JobRunner;
  /** Send a push to the server (the IPC channel). */
  send(message: BuilderToServer): void;
}

export class CliJobs {
  constructor(private readonly deps: CliJobDeps) {}

  /**
   * Run one `cliIndex` of `mode` on `root`. Resolves with the IndexResult once the job ended; rejects with its
   * error. `requestId` names the request the events are pushed for. A mode that needs the lease and finds none
   * (never taken, or ended) rejects before anything is queued; a lease job that waits in the queue past the end
   * of its lease refuses to run. A root in no git worktree rejects every mode before anything is queued. A root
   * fenced for its removal rejects every mode, when asked and again when the job starts ("the index of <root> is
   * being removed"). A run that ends ok, in any mode, clears the root's stopped-over-limit marks: init queues an
   * 'init' job and every other mode an 'index' job, and JobQueue clears the marks when either succeeds.
   */
  cliIndex(requestId: number, root: string, mode: CliIndexMode, verbose = false): Promise<IndexResult> {
    try {
      requireAbsoluteRoot(root);
      const required = requireGitWorktreeRoot(root);
      if ('refusal' in required) throw new Error(required.refusal);
      this.deps.fences.refuseIfRemoving(root);
      const emit = (event: IndexWriteEvent): void => this.deps.send({ op: 'requestEvent', requestId, event });
      // Every job first asks again whether the root is being removed (the fence may have come while it
      // waited), then runs its prelude (the lease's checks and locks), then its body.
      const run = async (jobId: number, open: 'init' | 'recreate' | 'open', prelude?: () => Promise<void> | void): Promise<IndexResult> => {
        this.deps.fences.refuseIfRemoving(root);
        await prelude?.();
        return runIndexJob(this.deps.runJob, jobId, { root, open, verbose }, emit);
      };
      switch (mode) {
        case 'init':
          return this.deps.queue.enqueue('init', root, ({ id }) => run(id, 'init'));
        case 'reindex':
          return this.deps.queue.enqueue('index', root, ({ id }) => run(id, 'open'));
        case 'rebuild':
          return this.underLease(root, (lease, id) => run(id, 'recreate', () => this.takeRebuildWriter(lease)));
        case 'reindex-leased':
          return this.underLease(root, (lease, id) => run(id, 'open', () => lease.assertLive()));
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
   * Rejects, when asked and again when the job starts, for a root fenced for its removal, and before anything is
   * queued for a root in no git worktree.
   */
  cliSync(requestId: number, root: string): Promise<SyncResult> {
    try {
      requireAbsoluteRoot(root);
      const required = requireGitWorktreeRoot(root);
      if ('refusal' in required) throw new Error(required.refusal);
      this.deps.fences.refuseIfRemoving(root);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.deps.queue.enqueue('sync', root, async ({ id }) => {
      // A removal fenced the root while the job waited.
      this.deps.fences.refuseIfRemoving(root);
      return runSyncJob(this.deps.runJob, id, 'sync', root, {
        onProgress: (progress) => this.deps.send({ op: 'requestEvent', requestId, event: { kind: 'progress', progress } }),
      });
    });
  }

  /**
   * Queue an `index` job that needs the lease of `root`, and add it to the lease so `unfence` waits for it.
   * The lease is looked up now (no lease: rejected) and checked again when the job starts (`run` asserts it).
   * What is tracked is the promise the request answers with, so `unfence` answers after the job's own reply.
   */
  private underLease(root: string, run: (lease: RebuildLease, jobId: number) => Promise<IndexResult>): Promise<IndexResult> {
    const lease = this.deps.fences.requireLive(root);
    const job = this.deps.queue.enqueue('index', root, ({ id }) => run(lease, id));
    lease.track(job);
    return job;
  }

  /**
   * The rebuild's locks, taken in the builder before its child runs. The builder's own hold of the root (its
   * watcher and `writer.pid`) goes first: the server released its handle before it asked for this job, but a
   * hold of the builder's may still be there: an `open` job that ran after the fence refuses to open (holder.ts
   * openWritable), leaving the hold entry. This job is the root's running job, so the release must not wait for
   * the root to go idle. Then `writer.pid` is taken with mode `rebuild` under the builder's pid, for the lease to
   * release at `unfence`: a lock under the child's pid would be left behind when the child exits.
   */
  private async takeRebuildWriter(lease: RebuildLease): Promise<void> {
    lease.assertLive();
    await this.deps.holders.release(lease.root, { fromJobOfRoot: true });
    const writer = tryAcquireWriterLock(lease.root, 'rebuild');
    if (writer.kind === 'taken') throw new Error(writerLockHeldMessage(writer.existing, writer.pidPath));
    lease.noteWriter();
  }
}

/** A root from the IPC must be an absolute path: a relative one would mean this process's working directory. */
export function requireAbsoluteRoot(root: unknown): string {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error(`the root must be an absolute path: ${String(root)}`);
  return root;
}
