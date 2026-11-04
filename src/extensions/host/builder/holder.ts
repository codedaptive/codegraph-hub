/**
 * The roots the index builder holds. A held root is one the builder keeps open for writing: its database is
 * open writable (so the migrations ran), `writer.pid` names the builder, a FileWatcher watches its working
 * tree, and every write to it, whoever asked, is a job on the builder's queue (./queue.ts), except the
 * oversized-WAL checkpoint a writable open starts, which its job does not await (see openWritable).
 *
 * This is the project writer for the HELD roots: the one place a held root's writer slot, watcher and syncs
 * are owned, so the server only reads (a CLI command's one-shot index writes on a root, which need no hold,
 * are ./cli-jobs.ts's):
 *   - the writable open is a job: taking `writer.pid` and opening the database (which can run migrations,
 *     heal an interrupted bulk load and do WAL maintenance) is an `open` job on the queue, SYNC class, so it
 *     never runs beside a cold build or another root's sync;
 *   - one writer per root: `writer.pid` is taken with mode `builder`; when another live process owns it (a
 *     `codegraph watch`, a server of another state dir) the hold serves no writes and tries again every
 *     {@link HolderDeps.ownRetryMs};
 *   - a hold never starts, opens or takes over a root while a rebuild holds it: `rebuild.pid` of another
 *     live process (`codegraph index` in its own process), or a fence this builder gave a `codegraph index`
 *     that runs through the server (./fences.ts);
 *   - a hold ends when the root is released (stop the watcher, wait out a running job, close, free
 *     `writer.pid`).
 *
 * The watcher is a FileWatcher whose sync function QUEUES a `watch-sync` job, not `CodeGraph.watch()`, whose
 * syncs would run outside the queue and so outside its priorities. On Windows the watcher gets the same filter
 * `CodeGraph.watch()` gives its own: {@link isIndexedFileStateCurrent} drops the NTFS last-access
 * notifications (#1451) of files whose indexed size and mtime still match. It is a copy of `CodeGraph`'s
 * private check, built on the public `getFile`; only its POSIX-runnable behavior is tested here, never a
 * Windows run.
 *
 * The watcher state the server needs for its stale-index notices (watching, degraded, recovering, the pending
 * files) is polled every {@link HolderDeps.pollMs} and pushed through `onFreshness` when it changed: the
 * FileWatcher has no event for "the pending set changed".
 */
import * as fs from 'fs';
import * as path from 'path';
import CodeGraph from '../../../index';
import { canonicalProjectRoot, isInitialized } from '../../../directory';
import { FileWatcher, LockUnavailableError, type WatchOptions } from '../../../sync/watcher';
import { watchDisabledReason } from '../../../sync/watch-policy';
import { markWriterReady, readWriterLock, releaseWriterLock, tryAcquireWriterLock } from '../../../mcp/writer-lock';
import type { BuilderFreshness } from './client';
import type { RebuildFences } from './fences';
import type { JobQueue } from './queue';

export type HoldResult =
  | { kind: 'held'; root: string }
  /** The `open` job (and the recovery wait after it) had not finished within `openWaitMs`; it carries on in the queue. */
  | { kind: 'opening'; root: string }
  /** A `codegraph index` rebuild (another process's, or one fenced here), or another process's cold build, holds the root: nothing was opened. */
  | { kind: 'rebuilding'; root: string }
  | { kind: 'failed'; root: string; error: string };

export interface HolderDeps {
  queue: JobQueue;
  /** The builder's rebuild fences: a fenced root is never held, opened or taken over (see {@link RebuildFences.rebuildHeld}). */
  fences: RebuildFences;
  /** A held root's watcher state changed. */
  onFreshness(state: BuilderFreshness): void;
  /** One diagnostic line (stderr). */
  log(line: string): void;
  /** The watcher options for every root (debounce, logging callbacks). Called once per watcher. */
  watchOptions(): WatchOptions;
  /**
   * How long {@link HolderSet.hold} waits for the root's `open` job (queued behind whatever job runs: a cold
   * build runs for minutes and is never preempted) and what follows it, before it answers `opening` and
   * leaves the open queued.
   */
  openWaitMs: number;
  /** How long a hold waits for its `recover` job before the open answers anyway. */
  recoverWaitMs: number;
  /** How often a hold whose `writer.pid` another process owns tries to take it. */
  ownRetryMs: number;
  /** How often the watchers' state is read for changes. */
  pollMs: number;
}

interface Hold {
  /** Identity key: one entry however the root is spelled. */
  key: string;
  /** The realpath the index is opened at. */
  root: string;
  cg: CodeGraph | null;
  watcher: FileWatcher | null;
  /** This process owns `writer.pid`, so it writes this root. False while another live process does. */
  owner: boolean;
  closed: boolean;
  /** The `open` job is queued and has not started: a release need not wait for it, since it finds the hold closed and opens nothing. */
  openJobPending: boolean;
  opening: Promise<HoldResult>;
  /**
   * Settles (never rejects) when the first catch-up job has run; at once when none was queued (another process
   * owns `writer.pid` or a rebuild holds the root, so nothing was opened). A catch-up that found the lock held
   * settles at that failure, before the retry it schedules (see queueCatchUp).
   */
  caughtUp: Promise<void>;
  /**
   * A publication of the root's readiness threw, the catch-up's or a retry by {@link HolderSet.caughtUp} (see
   * `publishReady`) or returned without making the record ready. False until then, and again only once the record
   * reads ready for this process (a silent no-op does not clear it); a later {@link HolderSet.caughtUp} retries
   * while it is set.
   */
  publishFailed: boolean;
  /** The retry for a root another process owns. */
  ownTimer: NodeJS.Timeout | null;
  closing: Promise<void> | null;
  /** JSON of the last freshness pushed. */
  lastPushed: string;
}

/**
 * Whether the index's record for `relPath` (project-relative, POSIX) still matches the file on disk: tracked,
 * a regular file, and the same size and whole-millisecond mtime. False for an untracked file, a missing or
 * unreadable one (a removal or a transient failure must reach the sync), or when `cg` is null or unreadable.
 *
 * The same comparison as `CodeGraph.isIndexedFileStateCurrent` (src/index.ts, private; `CodeGraph.watch()`
 * passes it to its watcher on Windows only, to discard NTFS last-access notifications, #1451), built on the
 * public `getFile` because the builder's watcher queues its syncs and so cannot use `CodeGraph.watch()`.
 */
export function isIndexedFileStateCurrent(
  cg: Pick<CodeGraph, 'getFile'> | null,
  projectRoot: string,
  relPath: string,
): boolean {
  if (cg === null) return false;
  try {
    const tracked = cg.getFile(relPath);
    if (!tracked) return false;
    const stat = fs.statSync(path.join(projectRoot, relPath));
    return (
      stat.isFile() &&
      Number.isFinite(stat.mtimeMs) &&
      Number.isFinite(tracked.modifiedAt) &&
      stat.size === tracked.size &&
      Math.floor(stat.mtimeMs) === Math.floor(tracked.modifiedAt)
    );
  } catch {
    return false;
  }
}

/** True when a process with this pid exists (EPERM: it exists, we may not signal it). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Longest wait between two catch-up retries after lock contention. */
const CATCH_UP_RETRY_MAX_MS = 30_000;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolves with `promise`'s outcome, or with `undefined` after `ms`; never rejects. */
async function boundedWait(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
  ]);
  clearTimeout(timer);
}

export class HolderSet {
  private readonly holds = new Map<string, Hold>();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: HolderDeps) {}

  /** The canonical keys of the held roots. */
  roots(): string[] {
    return [...this.holds.keys()];
  }

  has(root: string): boolean {
    const hold = this.holds.get(canonicalProjectRoot(root));
    return hold !== undefined && !hold.closed;
  }

  /**
   * Hold `root`, which has a complete index: queue an `open` job that takes `writer.pid` and opens the
   * database writable (the open can run migrations, heal an interrupted bulk load and do WAL maintenance, so
   * it is a job like every write), then recover what an interrupted bulk load dropped (a `recover` job, waited
   * for at most `recoverWaitMs`), start the watcher and queue the catch-up. Answers:
   *   - `held` when that is done up to the catch-up's queuing, and also for a root another live process owns
   *     (nothing was opened here; the retry takes over when that process exits). Only a `held` whose open job
   *     ran means the migrations ran;
   *   - `opening` when `openWaitMs` passed first: a running job (a cold build, for minutes) is never
   *     interrupted, so the open starts after it, and the work carries on in the queue;
   *   - `failed` when the index could not be opened, `rebuilding` while a rebuild holds `rebuild.pid`.
   * A root already held answers at once.
   */
  async hold(rootIn: string): Promise<HoldResult> {
    const root = this.resolveRoot(rootIn);
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<HoldResult>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'opening', root }), this.deps.openWaitMs);
    });
    try {
      return await Promise.race([this.holdNow(rootIn), waited]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The realpath of `rootIn` (the lexical path when it cannot be resolved). */
  private resolveRoot(rootIn: string): string {
    try { return fs.realpathSync(rootIn); } catch { return path.resolve(rootIn); }
  }

  /** {@link hold} without its wait: settles when the hold is open. */
  private holdNow(rootIn: string): Promise<HoldResult> {
    const root = this.resolveRoot(rootIn);
    const key = canonicalProjectRoot(root);
    const existing = this.holds.get(key);
    // A hold that is being released finishes first: the new one must not take `writer.pid` for the old
    // one's teardown to free.
    if (existing?.closing) return existing.closing.then(() => this.holdNow(rootIn));
    if (existing) return existing.opening;
    if (this.deps.fences.rebuildHeld(root)) return Promise.resolve({ kind: 'rebuilding', root });
    const hold: Hold = {
      key, root, cg: null, watcher: null, owner: false, closed: false, openJobPending: false,
      opening: Promise.resolve({ kind: 'held', root }), caughtUp: Promise.resolve(),
      publishFailed: false, ownTimer: null, closing: null, lastPushed: '',
    };
    this.holds.set(key, hold);
    hold.opening = this.open(hold).then(
      (): HoldResult => {
        if (!hold.closed) {
          this.startPolling();
          this.pushIfChanged(hold);
        }
        return { kind: 'held', root };
      },
      (err: unknown): HoldResult => {
        // A release may already have replaced this entry with a newer hold of the same root.
        if (this.holds.get(key) === hold) this.holds.delete(key);
        // Logged here, not by the caller: an open that outlasted the caller's wait has no caller left to tell.
        this.deps.log(`Could not hold ${root}: ${messageOf(err)}`);
        return { kind: 'failed', root, error: messageOf(err) };
      },
    );
    return hold.opening;
  }

  /**
   * Resolves when the root's first catch-up has run (ok or failed); at once when it is not held, or when no
   * catch-up was queued (another process owns `writer.pid`, or a rebuild holds the root). A catch-up that found
   * the lock held resolves at that failure, before its retry, which this call does not wait for. Never rejects.
   * When that catch-up's readiness publication threw (logged) or returned without the record reading ready (not
   * logged), this call tries the publication again, so a later call can still make the root ready.
   */
  async caughtUp(root: string): Promise<void> {
    const hold = this.holds.get(canonicalProjectRoot(root));
    if (!hold) return;
    await hold.opening;
    await hold.caughtUp;
    if (hold.publishFailed && !hold.closed) this.publishReady(hold);
  }

  /**
   * Sync a held `root` at sync priority (the server's `sync` request). Concurrent calls for one root share the
   * job while it waits. Resolves with the number of files changed; rejects when the root is not held or the
   * sync fails. A root another process owns resolves with 0: that process syncs it. The codegraph CLI's sync
   * of any root, held or not, answers a whole SyncResult and is `cliSync` (./cli-jobs.ts).
   */
  async sync(root: string): Promise<{ filesChanged: number }> {
    const hold = this.holds.get(canonicalProjectRoot(root));
    if (!hold || hold.closed) throw new Error(`${root} is not held by the index builder`);
    await hold.opening;
    if (!hold.owner) return { filesChanged: 0 };
    return this.deps.queue.enqueue('sync', hold.root, async () => {
      const cg = this.openGraph(hold);
      const r = await cg.sync();
      return { filesChanged: r.filesAdded + r.filesModified + r.filesRemoved };
    }, { coalesceKey: `sync:${hold.key}` });
  }

  /**
   * Drop the hold on `root`: stop its watcher, let a job that is running on it finish, close the database,
   * free `writer.pid`. Resolves after, so another process can take the slot. A root not held resolves at once.
   */
  release(root: string): Promise<void> {
    const hold = this.holds.get(canonicalProjectRoot(root));
    if (!hold) return Promise.resolve();
    if (!hold.closing) hold.closing = this.teardown(hold);
    return hold.closing;
  }

  /**
   * The open writable graph of a root this builder holds and owns (`writer.pid` is its), or null. Asked by a
   * job that runs on the queue (the CLI's `sync`, ./cli-jobs.ts), which syncs through it rather than opening
   * the database a second time.
   */
  ownedGraph(root: string): CodeGraph | null {
    const hold = this.holds.get(canonicalProjectRoot(root));
    return hold && !hold.closed && hold.owner ? hold.cg : null;
  }

  /** The watcher state of a held root; null when it is not held. */
  freshness(root: string): BuilderFreshness | null {
    const hold = this.holds.get(canonicalProjectRoot(root));
    return hold && !hold.closed ? this.freshnessOf(hold) : null;
  }

  /** Release every hold (a stopping builder). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.holds.values()].map((hold) => this.release(hold.root)));
  }

  // -------------------------------------------------------------------------

  private openGraph(hold: Hold): CodeGraph {
    if (hold.closed || !hold.cg) throw new Error(`${hold.root} was released by the index builder`);
    return hold.cg;
  }

  /** Open (a job), recover, watch, queue the catch-up. Throws when the index cannot be opened. */
  private async open(hold: Hold): Promise<void> {
    if (!isInitialized(hold.root)) throw new Error(`${hold.root} has no index`);
    await this.activate(hold);
  }

  private async activate(hold: Hold): Promise<void> {
    // Taking the slot and opening writable is one job: the open can migrate, heal bulk-load state and start WAL
    // maintenance (not awaited by the job, see openWritable), so it waits for the running job like every write
    // does. The recovery and the catch-up are jobs of their own (a job cannot wait for another on a queue that
    // runs one at a time), queued after it.
    hold.openJobPending = true;
    const opened = await this.deps.queue.enqueue('open', hold.root, async () => {
      hold.openJobPending = false;
      return this.openWritable(hold);
    });
    if (opened === null || hold.closed) return;
    if (opened.recoveryPending) {
      // Off this thread (#1887), as a job so it does not overlap another root's write. A recovery that outlasts
      // the wait leaves the indexes slower, never wrong, for the reader; the catch-up queues behind it.
      const recovery = this.deps.queue.enqueue('recover', hold.root, () => this.openGraph(hold).recoverIndexes());
      recovery.catch((err: unknown) => this.deps.log(`index recovery of ${hold.root} failed: ${messageOf(err)}`));
      await boundedWait(recovery, this.deps.recoverWaitMs);
      if (hold.closed) return;
    }
    this.startWatcher(hold);
    hold.caughtUp = this.queueCatchUp(hold, 0);
  }

  /**
   * The body of the `open` job: take `writer.pid` and open the database writable. Null when nothing was
   * opened: the hold was released while the job waited, a rebuild holds the root now (one that started while
   * the job waited: the retry opens it once the rebuild is over), or another live process owns the slot (this
   * serves nothing for the root, and the retry takes over when that process exits). Throws when the index
   * cannot be opened.
   *
   * Not awaited by the job: the open starts CodeGraph's oversized-WAL heal fire-and-forget (db/index.ts `open`,
   * `void conn.healOversizedWal()`: an off-thread PASSIVE then TRUNCATE checkpoint), and the job ends without
   * awaiting it. The connection is private to CodeGraph (src/index.ts), and src/index.ts is upstream, not
   * editable from this zone, so the job has no handle on the checkpoint. The checkpoint can therefore overlap
   * the next job. When that job writes the same database, SQLite serializes the two itself; when it writes
   * another root's database, they run side by side.
   */
  private openWritable(hold: Hold): { recoveryPending: boolean } | null {
    if (hold.closed) return null;
    // A rebuild (fenced here, or another process's `rebuild.pid`) may have started since holdNow looked: the
    // open would take `writer.pid` and migrate a database the rebuild is about to replace.
    if (this.deps.fences.rebuildHeld(hold.root)) {
      hold.owner = false;
      this.scheduleOwnRetry(hold);
      return null;
    }
    const writer = tryAcquireWriterLock(hold.root, 'builder');
    if (writer.kind === 'taken') {
      // Another process owns this project's updates (a CLI watcher, a server of another state dir). It does
      // not take work from us: serve nothing here, and take over when it exits.
      hold.owner = false;
      this.scheduleOwnRetry(hold);
      return null;
    }
    hold.owner = true;
    let cg: CodeGraph;
    try {
      cg = CodeGraph.openSync(hold.root, { deferIndexRecovery: true });
    } catch (err) {
      hold.owner = false;
      releaseWriterLock(hold.root);
      throw err;
    }
    hold.cg = cg;
    return { recoveryPending: cg.hasPendingIndexRecovery() };
  }

  /**
   * The retry for a root whose `writer.pid` another live process owns, or that a rebuild holds. While that
   * process lives, or the rebuild runs, the retry does nothing, not even a job (a job per
   * {@link HolderDeps.ownRetryMs} would fill builder.log); once its pid is gone, or the rebuild is over, the
   * open runs as a job again.
   */
  private scheduleOwnRetry(hold: Hold): void {
    if (hold.ownTimer || hold.closed) return;
    hold.ownTimer = setTimeout(() => {
      hold.ownTimer = null;
      if (hold.closed || hold.owner || !isInitialized(hold.root)) return;
      // While a rebuild holds the root nothing is taken over; the next tick looks again.
      if (this.deps.fences.rebuildHeld(hold.root)) {
        this.scheduleOwnRetry(hold);
        return;
      }
      const other = readWriterLock(hold.root);
      if (other && other.pid !== process.pid && pidAlive(other.pid)) {
        this.scheduleOwnRetry(hold);
        return;
      }
      this.activate(hold).catch((err: unknown) => {
        this.deps.log(`could not take over ${hold.root}: ${messageOf(err)}`);
        this.scheduleOwnRetry(hold);
      });
    }, this.deps.ownRetryMs);
    hold.ownTimer.unref();
  }

  private startWatcher(hold: Hold): void {
    const disabled = watchDisabledReason(hold.root);
    if (disabled) {
      this.deps.log(`File watcher disabled for ${hold.root} — ${disabled}.`);
      return;
    }
    const options = this.deps.watchOptions();
    hold.watcher = new FileWatcher(
      hold.root,
      async (paths) => {
        const r = await this.deps.queue.enqueue('watch-sync', hold.root, () => this.openGraph(hold).sync({ paths }));
        return { filesChanged: r.filesAdded + r.filesModified + r.filesRemoved, durationMs: r.durationMs };
      },
      {
        ...options,
        onDegraded: (reason) => {
          options.onDegraded?.(reason);
          this.pushIfChanged(hold);
        },
      },
      // Windows only, as `CodeGraph.watch()` passes its own filter.
      process.platform === 'win32'
        ? (relPath) => isIndexedFileStateCurrent(hold.cg, hold.root, relPath)
        : undefined,
    );
    if (hold.watcher.start()) this.deps.log(`File watcher active for ${hold.root} — graph will auto-sync on changes`);
    else this.deps.log(`File watcher could not start for ${hold.root}`);
  }

  /**
   * The catch-up sync after a hold: one job that reconciles what changed while nobody held the root. Lock
   * contention (a CLI index run holds `codegraph.lock`) is retried with a growing wait; any other failure is
   * logged and left to the watcher's and the callers' syncs. A readiness publication afterwards that throws
   * (logged) or leaves the record not ready (not logged) is retried by a later {@link caughtUp}. Settles, never rejects, when the job has run: on lock
   * contention that is at the failure, before the retry, which is not waited for.
   */
  private queueCatchUp(hold: Hold, attempt: number): Promise<void> {
    return this.deps.queue.enqueue('catch-up', hold.root, () => this.openGraph(hold).sync()).then(
      (r) => {
        if (hold.closed) return;
        this.publishReady(hold);
        const changed = r.filesAdded + r.filesModified + r.filesRemoved;
        if (changed > 0) this.deps.log(`Caught up ${changed} file(s) changed since last run in ${hold.root}`);
      },
      (err: unknown) => {
        if (hold.closed) return;
        if (err instanceof LockUnavailableError) {
          // The first retry waits 1 s and the wait doubles per attempt: a CLI index run holds codegraph.lock for
          // a while, so the retries back off rather than hammer it. Capped at CATCH_UP_RETRY_MAX_MS.
          const wait = Math.min(1_000 * 2 ** attempt, CATCH_UP_RETRY_MAX_MS);
          const timer = setTimeout(() => {
            if (!hold.closed) void this.queueCatchUp(hold, attempt + 1);
          }, wait);
          timer.unref();
          return;
        }
        this.deps.log(`Catch-up sync failed for ${hold.root}: ${messageOf(err)}`);
      },
    );
  }

  /**
   * Publish the root's readiness; a throw is logged and recorded on the hold, never propagated. The flag clears
   * only when the record then reads ready for this process: `markWriterReady` returns without writing when the
   * record cannot be read or names another pid, so a silent no-op keeps the retry eligible (and logs nothing,
   * since it would repeat on every `caughtUp`).
   */
  private publishReady(hold: Hold): void {
    try {
      markWriterReady(hold.root);
      const info = readWriterLock(hold.root);
      hold.publishFailed = !(info && info.pid === process.pid && info.ready === true);
    } catch (err) {
      hold.publishFailed = true;
      this.deps.log(`Could not publish readiness of ${hold.root}: ${messageOf(err)}`);
    }
  }

  private async teardown(hold: Hold): Promise<void> {
    hold.closed = true;
    if (hold.ownTimer) clearTimeout(hold.ownTimer);
    hold.ownTimer = null;
    // An open that has started finishes first, so what it acquired is what is released. One still waiting in
    // the queue (behind a cold build, say) is not waited for: it finds the hold closed and opens nothing.
    if (!hold.openJobPending) await hold.opening;
    hold.watcher?.stop();
    hold.watcher = null;
    const cg = hold.cg;
    if (cg) {
      // A job that is running on this graph owns the database until it ends; the jobs still queued for the
      // root refuse to run (openGraph), so this wait ends.
      while (cg.isIndexing()) await new Promise<void>((resolve) => setTimeout(resolve, 25));
      try { cg.close(); } catch { /* already closed */ }
      hold.cg = null;
    }
    if (hold.owner) releaseWriterLock(hold.root);
    hold.owner = false;
    this.holds.delete(hold.key);
    if (this.holds.size === 0) this.stopPolling();
  }

  // -------------------------------------------------------------------------
  // Freshness
  // -------------------------------------------------------------------------

  private freshnessOf(hold: Hold): BuilderFreshness {
    const w = hold.watcher;
    return {
      root: hold.key,
      watching: w?.isActive() ?? false,
      degradedReason: w?.getDegradedReason() ?? null,
      recovering: w?.isRecoveringFromLock() ?? false,
      pendingFiles: w ? w.getPendingFiles().map((p) => p.path) : [],
    };
  }

  private pushIfChanged(hold: Hold): void {
    if (hold.closed) return;
    const state = this.freshnessOf(hold);
    const json = JSON.stringify(state);
    if (json === hold.lastPushed) return;
    hold.lastPushed = json;
    this.deps.onFreshness(state);
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.tick(), this.deps.pollMs);
    this.pollTimer.unref();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private tick(): void {
    for (const hold of this.holds.values()) {
      if (hold.closed) continue;
      // A watcher parked by lock contention is re-armed here; the watcher's own cooldown throttles it.
      if (hold.watcher?.rearmAfterLockContention()) this.deps.log(`Re-armed file watcher for ${hold.root}; full catch-up pending.`);
      this.pushIfChanged(hold);
    }
  }
}
