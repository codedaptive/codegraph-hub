/**
 * The rebuild lease the builder gives a `codegraph index` or a `codegraph uninit` that runs through the server
 * (./cli-wire.ts): a fence on one root, held from the `fence` request until the `unfence` request (or the
 * builder's stop). The fence has a {@link FenceKind}. An `index` fence is a rebuild's: its own jobs run under it
 * (below), and a `sync` job of the root still runs, as an in-process `codegraph sync` runs during another
 * process's rebuild. A `release` fence is an `uninit`'s: the server and the builder let go of the root, the CLI
 * deletes `.codegraph`, and from the fence until its `unfence` the builder starts no job that opens the root:
 * the CLI's `sync`, `init`, `index` and every re-run refuse ({@link RebuildFences.refuseIfRemoving}), a hold's
 * open and its retry refuse ({@link RebuildFences.rebuildHeld}), a seed refuses when its source or its target is the
 * root (./seed-host.ts, checked when the seed job starts; a seed never picks a fenced source), and a cold build
 * refuses a fenced root. A job already running when the fence arrives is not stopped; the `drain` request waits for
 * every job that names the root, as its own or as the source it reads (./queue.ts `whenRootIdle`). Not covered:
 * connections the engine opens on its own and that teardown does not track (a deferred index recovery that outlasted
 * its wait, the oversized-WAL checkpoint of a writable open: upstream src/index.ts and src/db). The `unfence` of a
 * removal finds `rebuild.pid` already gone with the directory, which {@link RebuildFences.unfence} tolerates.
 *
 * While a root is fenced the builder keeps `rebuild.pid` for it, so every reader, seeder and holder of every
 * process refuses to open the index as they do while the in-process `codegraph index` runs. `rebuild.pid`
 * alone is not enough inside this process: a record that names this pid is the builder's own (it is not
 * "another process's rebuild", see writer-lock.ts `isRebuildInProgress`), so the builder's own holders and
 * seeders ask {@link RebuildFences.rebuildHeld}, which adds the fence registry to that check.
 *
 * The lease's jobs (./cli-jobs.ts) run on the builder's queue and may take `writer.pid` for the lease; the
 * locks stay until the lease ends, so the interactive re-run of `index` runs under them as the in-process
 * command holds them. {@link RebuildFences.unfence} waits for the lease's jobs before it lets either lock go:
 * a running job is never preempted (queue.ts), and releasing `writer.pid` under it would delete the live run's
 * own same-pid lock (writer-lock.ts `releaseWriterLock`).
 *
 * One registry per {@link BuilderService}: tests run several services in one process, and the roots one
 * service fences are not another's.
 */
import { canonicalProjectRoot } from '../../../directory';
import { isRebuildInProgress, readWriterLock, releaseWriterLock, tryAcquireWriterLock } from '../../../mcp/writer-lock';
import type { JobQueue } from './queue';

/** The CLI's own refusal text for a root whose rebuild lock is taken, so a routed `index` says what an in-process one does. */
export const REBUILD_IN_PROGRESS_MESSAGE = 'Another index rebuild is already in progress.';

/**
 * What a fence is for. `index`: a `codegraph index` that rebuilds the root under it (its jobs need the lease).
 * `release`: a `codegraph uninit` that deletes the root's index under it; no job may open the root meanwhile.
 */
export type FenceKind = 'index' | 'release';

/** Parse the kind a `fence` request carries (IPC data): absent is `index`; anything but the two kinds is refused. */
export function parseFenceKind(raw: unknown): FenceKind {
  if (raw === undefined || raw === 'index') return 'index';
  if (raw === 'release') return 'release';
  throw new Error(`unknown fence kind: ${String(raw)}`);
}

/** One root's lease. */
export class RebuildLease {
  /** `unfence` was called (or the builder is stopping): a job that has not started refuses to run. */
  ending = false;
  /** The locks are released and the record dropped. */
  released = false;
  /** The lease's job took `writer.pid`, so ending the lease releases it. */
  private holdsWriter = false;
  /** The lease's jobs, queued or running, as promises that never reject. */
  private readonly jobs = new Set<Promise<void>>();

  constructor(readonly key: string, readonly root: string, readonly kind: FenceKind) {}

  /** Throws unless the lease is still live. Run when a lease job starts, and when one is asked for. */
  assertLive(): void {
    if (this.ending || this.released) throw new Error(`the index lease for ${this.root} ended`);
  }

  /** Record that `writer.pid` is the lease's, to be released with it. */
  noteWriter(): void {
    this.holdsWriter = true;
  }

  get writer(): boolean {
    return this.holdsWriter;
  }

  /** Add a job (the promise its request answers with); it leaves the set when it settles. */
  track(job: Promise<unknown>): void {
    const settled: Promise<void> = job.then(() => undefined, () => undefined).then(() => { this.jobs.delete(settled); });
    this.jobs.add(settled);
  }

  /** Resolves once every tracked job has settled, including those added while waiting. */
  async idle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.all([...this.jobs]);
  }
}

export class RebuildFences {
  private readonly leases = new Map<string, RebuildLease>();
  private readonly ending = new Map<RebuildLease, Promise<void>>();

  /** `queue` tells whether a cold build of this process is running on a root (it holds `rebuild.pid` under this pid). */
  constructor(private readonly queue: JobQueue, private readonly log: (line: string) => void) {}

  /** Whether `root` is fenced, from the request until its locks are released. */
  isFenced(root: string): boolean {
    return this.leases.has(canonicalProjectRoot(root));
  }

  /**
   * Whether a rebuild keeps readers and the builder's own writers off `root`: another live process holds
   * `rebuild.pid`, or this builder fenced the root.
   */
  rebuildHeld(root: string): boolean {
    return isRebuildInProgress(root) || this.isFenced(root);
  }

  /**
   * Whether `root` is fenced for a removal (kind `release`) and the fence has not ended: no job of the builder
   * may open it. An `index` fence, or none, is false.
   */
  isRemoving(root: string): boolean {
    const lease = this.leases.get(canonicalProjectRoot(root));
    return lease !== undefined && lease.kind === 'release' && !lease.released;
  }

  /**
   * Throws the removal refusal ("the index of <root> is being removed") when {@link isRemoving}. Run when a job
   * that would open `root` is asked for and again when it starts, so a job queued before the fence refuses too.
   */
  refuseIfRemoving(root: string): void {
    if (this.isRemoving(root)) throw new Error(`the index of ${root} is being removed`);
  }

  /**
   * Fence `root` for `kind`: take its `rebuild.pid`. Refused ({@link REBUILD_IN_PROGRESS_MESSAGE}) when the root is
   * fenced already, when another live process holds `rebuild.pid`, when this pid holds it for a cold build
   * that is running now, or when the lock cannot be taken. A `rebuild.pid` that names this pid with no running
   * holder is a leftover of an earlier lease or cold build and is adopted. Answers at once: nothing is queued.
   */
  fence(root: string, kind: FenceKind = 'index'): void {
    const key = canonicalProjectRoot(root);
    if (this.leases.has(key)) throw new Error(REBUILD_IN_PROGRESS_MESSAGE);
    if (isRebuildInProgress(root)) throw new Error(REBUILD_IN_PROGRESS_MESSAGE);
    // The cold build takes `rebuild.pid` inside its job, under this pid, so only the running job tells a record
    // in use from a leftover. A cold build still queued has taken nothing: it checks the fence when it starts.
    if (readWriterLock(root, 'rebuild.pid')?.pid === process.pid && this.coldBuildRunningOn(key)) {
      throw new Error(REBUILD_IN_PROGRESS_MESSAGE);
    }
    if (tryAcquireWriterLock(root, 'rebuild', 'rebuild.pid').kind === 'taken') throw new Error(REBUILD_IN_PROGRESS_MESSAGE);
    this.leases.set(key, new RebuildLease(key, root, kind));
  }

  /** The live lease of `root`, for a job that needs one. Throws when there is none or it is ending. */
  requireLive(root: string): RebuildLease {
    const lease = this.leases.get(canonicalProjectRoot(root));
    if (!lease) throw new Error(`no index lease is held for ${root}`);
    lease.assertLive();
    return lease;
  }

  /**
   * End the lease on `root`: mark it ending at once (a lease job that has not started refuses to run), wait
   * for the lease's queued and running jobs to settle, then release `writer.pid` (when a job took it for the
   * lease) and `rebuild.pid`, and drop the record even when a release throws (logged). Resolves when that is
   * done; never rejects. A root with no lease resolves at once.
   */
  unfence(root: string): Promise<void> {
    const lease = this.leases.get(canonicalProjectRoot(root));
    if (!lease) return Promise.resolve();
    lease.ending = true;
    let done = this.ending.get(lease);
    if (!done) {
      done = this.end(lease);
      this.ending.set(lease, done);
    }
    return done;
  }

  /**
   * Release every lease without waiting for its jobs (a stopping builder: the queue was closed and given its
   * grace, so a job still running belongs to a process that is about to exit). Never throws.
   */
  releaseAll(): void {
    for (const lease of [...this.leases.values()]) {
      lease.ending = true;
      this.dropLocks(lease);
    }
  }

  private async end(lease: RebuildLease): Promise<void> {
    try {
      await lease.idle();
    } catch (err) {
      this.log(`waiting for the index lease of ${lease.root} to end failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.dropLocks(lease);
    }
  }

  /** Release the lease's locks (`writer.pid` first, then `rebuild.pid`) and drop its record, once. */
  private dropLocks(lease: RebuildLease): void {
    if (lease.released) return;
    lease.released = true;
    try {
      if (lease.writer) releaseWriterLock(lease.root);
    } catch (err) {
      this.log(`could not release writer.pid of ${lease.root}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      releaseWriterLock(lease.root, 'rebuild.pid');
    } catch (err) {
      this.log(`could not release rebuild.pid of ${lease.root}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.leases.get(lease.key) === lease) this.leases.delete(lease.key);
    this.ending.delete(lease);
  }

  private coldBuildRunningOn(key: string): boolean {
    const job = this.queue.runningJob();
    return job !== null && job.kind === 'cold-build' && canonicalProjectRoot(job.root) === key;
  }
}
