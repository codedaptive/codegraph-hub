/**
 * The index builder's logic, apart from its process (./main.ts) so a test can run it in-process: the queue,
 * the held roots, the cold-build and seed host, the rebuild fences, the codegraph CLI's jobs, the
 * housekeeping sweep, and the request handler the IPC channel feeds.
 *
 * The index writes the builder makes as jobs happen here, one job at a time on
 * {@link BuilderService.queue}: cold builds, seed copies, the writable open of a held root, the catch-up after
 * a hold, every sync (a caller's, a watcher's or the CLI's), index recovery, and the CLI's `init` and `index`
 * (./cli-jobs.ts, under a rebuild lease for `index`: ./fences.ts). The one write a job does not await is the
 * oversized-WAL checkpoint a writable open starts (see holder.ts openWritable). The housekeeping sweep runs on its own timer with its own hold set,
 * outside the queue, and tears down the indexes whose worktree is gone.
 */
import { canonicalProjectRoot } from '../../../directory';
import type { WatchOptions } from '../../../sync/watcher';
import { EngineHousekeeping } from '../worktree-lifecycle/housekeeping';
import { ensureWorktreeIndex, isAbandonedIndex } from '../worktree-lifecycle/seed';
import { selectOwnIndexRoot } from '../server/index-root';
import { CliJobs, requireAbsoluteRoot } from './cli-jobs';
import type { BuilderFreshness, EnsureOutcome } from './client';
import { RebuildFences, parseFenceKind } from './fences';
import { HolderSet } from './holder';
import type { BuilderRequest, BuilderToServer } from './protocol';
import { JobQueue, formatJobLine } from './queue';
import { BuilderSeedHost, resolveSeedWaitMs } from './seed-host';

export interface BuilderServiceOptions {
  /** Send a message to the server (the IPC channel). */
  send(message: BuilderToServer): void;
  /** One line for `<state dir>/builder.log`, written as it is given (no timestamp is added). */
  jobLog(line: string): void;
  /** One diagnostic line for stderr. */
  log(line: string): void;
  /** The watcher options for every held root (debounce, logging callbacks). */
  watchOptions(): WatchOptions;
  /** Test seams; the defaults are the builder's real settings. */
  timing?: { recoverWaitMs?: number; ownRetryMs?: number; pollMs?: number; seedWaitMs?: number };
  /** Run the housekeeping sweep on its own timer (default true). */
  housekeeping?: boolean;
}

export class BuilderService {
  readonly queue: JobQueue;
  readonly holders: HolderSet;
  /** This service's rebuild fences: shared by the holders, the seed host and the CLI's jobs, never a module-wide registry. */
  private readonly fences: RebuildFences;
  private readonly cliJobs: CliJobs;
  private readonly seedHost: BuilderSeedHost;
  private readonly housekeeping: EngineHousekeeping | null;

  constructor(private readonly opts: BuilderServiceOptions) {
    this.queue = new JobQueue({ onEvent: (event) => opts.jobLog(formatJobLine(event)) });
    this.fences = new RebuildFences(this.queue, (line) => opts.log(line));
    this.seedHost = new BuilderSeedHost(this.queue, {
      seedWaitMs: opts.timing?.seedWaitMs ?? resolveSeedWaitMs(),
      log: (line) => opts.log(line),
      fences: this.fences,
    });
    // The holders' timings. openWaitMs, the seed wait (CODEGRAPH_BUILDER_ENSURE_WAIT_MS, 10 s): how long an
    // `ensure` waits for its root's `open` job, which queues behind a running cold build, before it answers
    // and leaves the open queued. recoverWaitMs, 10 s: how long a hold waits for its recovery job before the
    // open answers anyway (a longer recovery leaves reads slower, never wrong). ownRetryMs, 1 s: how soon a
    // root another live process owns is tried again, so a takeover follows that process's exit quickly.
    // pollMs, 250 ms: how often watcher state is read for the freshness pushes to the server.
    this.holders = new HolderSet({
      queue: this.queue,
      fences: this.fences,
      onFreshness: (state) => opts.send({ op: 'freshness', state }),
      log: (line) => opts.log(line),
      watchOptions: () => opts.watchOptions(),
      openWaitMs: opts.timing?.seedWaitMs ?? resolveSeedWaitMs(),
      recoverWaitMs: opts.timing?.recoverWaitMs ?? 10_000,
      ownRetryMs: opts.timing?.ownRetryMs ?? 1_000,
      pollMs: opts.timing?.pollMs ?? 250,
    });
    this.cliJobs = new CliJobs({ queue: this.queue, holders: this.holders, fences: this.fences, send: (message) => opts.send(message) });
    // The sweep tears down registered projects whose worktree is gone and releases every held root whose index
    // vanished. It runs here, not in the server: the builder is the process that holds the roots and the one
    // allowed to delete an index. The server's own housekeeping only lets go of its read-only handles.
    this.housekeeping = opts.housekeeping === false ? null : new EngineHousekeeping({
      releaseProjectRoot: (root) => this.releaseAndTell(root),
      cachedProjectRoots: () => this.holders.roots(),
      readOnly: false,
    });
  }

  /** Start the housekeeping timer. */
  start(): void {
    this.housekeeping?.start();
  }

  /** One housekeeping pass now (the timer runs the same pass). */
  runHousekeepingPass(): Promise<void> {
    return this.housekeeping ? this.housekeeping.runPass() : Promise.resolve();
  }

  /**
   * Answer one request from the server: one reply, whatever happens. A failure is an `ok: false` reply with
   * the error's message and class name.
   */
  async handle(request: BuilderRequest): Promise<void> {
    try {
      const result = await this.dispatch(request);
      this.opts.send({ id: request.id, ok: true, result });
    } catch (err) {
      this.opts.send({
        id: request.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error ? { errorName: err.name } : {}),
      });
    }
  }

  private dispatch(request: BuilderRequest): Promise<unknown> {
    switch (request.op) {
      // The anchor is IPC data: anything but a string is no anchor.
      case 'ensure': return this.ensure(request.projectPath, typeof request.anchorRoot === 'string' ? request.anchorRoot : undefined);
      case 'caughtUp': return this.holders.caughtUp(request.root);
      case 'sync': return this.holders.sync(request.root);
      case 'release': return this.holders.release(request.root);
      // The CLI's requests. Their roots are IPC data: CliJobs refuses one that is not an absolute path, and the
      // fence calls are given the same check here.
      case 'fence': return runNow(() => this.fences.fence(requireAbsoluteRoot(request.root), parseFenceKind(request.kind)));
      case 'unfence': return runNow(() => this.fences.unfence(requireAbsoluteRoot(request.root)));
      // Waits for the root's own jobs only; the promise is the queue's, so a job's reply goes out before the drain's.
      case 'drain': return runNow(() => this.queue.whenRootIdle(requireAbsoluteRoot(request.root)));
      // Not an async wrapper: the promise handed back is the job's own, so a lease's `unfence` (which waits for
      // the jobs it tracks) answers after the job's reply.
      case 'cliIndex': return this.cliJobs.cliIndex(request.id, request.root, request.mode, request.verbose === true);
      case 'cliSync': return this.cliJobs.cliSync(request.id, request.root);
      default: return Promise.reject(new Error(`unknown builder request: ${String((request as { op?: unknown }).op)}`));
    }
  }

  /**
   * Resolve `projectPath` to the index that answers it and make it ready: seed or queue a cold build when the
   * worktree has none (seed.ts), then hold the root that has one. Resolves once the builder opened (and
   * migrated) the index, or after a bounded wait ({@link BuilderServiceOptions.timing} `seedWaitMs`, from
   * `CODEGRAPH_BUILDER_ENSURE_WAIT_MS`, default 10 s) when the open is queued behind a running job, or when
   * the hold could not open it (another live writer, an open failure). The server then opens read-only
   * whatever is on disk: the migrations are guaranteed only in the first case.
   *
   * A `projectPath` outside git with no index is cold-built at `anchorRoot` (the session's launch directory)
   * when there is one, else at the path itself (seed.ts).
   */
  async ensure(projectPath: string, anchorRoot?: string): Promise<EnsureOutcome> {
    const decision = await ensureWorktreeIndex(projectPath, this.seedHost, anchorRoot);
    if (decision.kind === 'building') return decision;
    if (decision.kind === 'none' && (decision.worktree !== undefined || decision.unbuilt !== undefined)) return decision;
    if (decision.kind === 'seeded') {
      const held = await this.holdRoot(decision.root);
      return held.kind === 'building' ? held : { ...decision, root: held.root };
    }
    // Nothing to seed or build: the call is answered from the index selectOwnIndexRoot names, if there is one.
    // That is never an index above a git repository nested around the path (another repository's), nor one
    // git could not vouch for (ownIndexRootFor fails closed): with seeding off, such a path holds nothing.
    // A git worktree's index a killed build left half-made is no index
    // (isAbandonedIndex, seed.ts). A plain directory's is never judged abandoned (it needs a `.git`): it is
    // held below, recovered, and a full catch-up queued, and the call may be answered from it before the
    // catch-up ends.
    const root = selectOwnIndexRoot(projectPath);
    if (root === null || isAbandonedIndex(root, (r) => this.fences.rebuildHeld(r))) return { kind: 'none' };
    return this.holdRoot(root);
  }

  /**
   * Hold `root`; a rebuild in progress answers `building`. Every other outcome answers `ready`, whatever the
   * hold made of it: the open job ran (the index is migrated), or the wait for it ran out (it is queued behind
   * a running job: the server opens read-only what is on disk), or the hold could not open the index (another
   * live process writes the root, or the open failed: the holder logged why). The server's own read-only open
   * reports an index that cannot be opened.
   */
  private async holdRoot(root: string): Promise<{ kind: 'ready'; root: string } | { kind: 'building'; root: string }> {
    const held = await this.holders.hold(root);
    if (held.kind === 'rebuilding') return { kind: 'building', root: held.root };
    return { kind: 'ready', root: held.root };
  }

  /** The watcher state of a held root. */
  freshness(root: string): BuilderFreshness | null {
    return this.holders.freshness(root);
  }

  /** Release a root on the builder's own account (its index vanished, or housekeeping tore it down), and tell the server. */
  private async releaseAndTell(root: string): Promise<void> {
    await this.holders.release(root);
    this.opts.send({ op: 'released', root: canonicalProjectRoot(root) });
  }

  /**
   * Stop. The jobs still queued are dropped and the one running gets `graceMs` to finish, so a cold build the
   * server's exit interrupted is not thrown away at once; then every hold is released (bounded: a job still
   * running past the grace leaves its root's lock for the next builder to reclaim, its pid being dead).
   * Last, whatever the earlier steps did, every rebuild fence is released (`rebuild.pid`, and `writer.pid` where
   * a lease took it), so a bounded stop never leaves a root fenced.
   */
  async stop(graceMs: number): Promise<void> {
    try {
      this.housekeeping?.stop();
      await Promise.race([this.queue.close(), new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref())]);
      // 2 s bounds the hold teardown so a stopping builder exits promptly even when a hold will not close.
      await Promise.race([this.holders.closeAll(), new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref())]);
    } finally {
      this.fences.releaseAll();
    }
  }
}

/** Run `fn` now and answer with its value as a promise; what it throws is a rejection. */
function runNow<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}
