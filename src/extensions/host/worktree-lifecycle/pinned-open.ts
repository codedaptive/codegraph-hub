/**
 * The machine server's opener of pinned projects: a pinned database stays open
 * and current.
 *
 * `codegraph project pin` only writes the project registry
 * (./project-registry.ts, flag PROJECT_FLAG_PINNED); nothing tells the server.
 * The idle release honors the pin (a pinned project is never idle-released),
 * but a project nobody has called yet is not in the server's cache, so after a
 * restart a pinned standing worktree would be neither open nor watched until
 * its first tool call. This opener closes that gap by reading the registry:
 * once at the server's start, and again after every housekeeping pass
 * (src/mcp/engine.ts), so a pin made while the server runs needs no control
 * request: it is picked up by the first pass that starts after the pass in
 * flight, if any, has finished, which is at a housekeeping tick after that. A
 * pass has no time bound (each open waits on the builder), and a call to
 * `pass()` while one runs returns that pass instead of starting another. With
 * CODEGRAPH_HOUSEKEEPING_INTERVAL_MS=0 no pass runs, so a later pin is picked
 * up at the next server start only.
 *
 * What "open" means is the tool handler's own path (ToolHandler.openPinnedProject
 * is awaitProjectGate with no session): the builder is asked to hold the root
 * (its watcher, its writer slot, a catch-up sync), then the server opens it
 * read-only. The server writes nothing here.
 *
 * A pinned root with no git worktree and no opted-in folder at or above it
 * (gitRootByStat in ../server/index-root.ts is null) is skipped, with a line saying so, before any
 * seed: it is neither seeded nor opened, whether or not it has an index. Its
 * registry record and its index stay; the opener deletes nothing.
 *
 * A pinned root in a git worktree with no index (isInitialized in src/directory.ts is false: no
 * `codegraph.db`, or one that is not a CodeGraph index) goes to a seed first when the
 * engine gives a `seed` dependency (the machine server wires it to the
 * builder's `seedWorktree` op, which runs seedWorktreeNow in
 * src/extensions/host/worktree-lifecycle/seed.ts): the index is copied from the
 * nearest sibling worktree that has a complete one, on the builder's job queue,
 * and the root is then opened as any indexed root is. It is never cold-built: a
 * root with no indexed sibling, or one the seed finds not in a git worktree, is
 * skipped with a line saying why, because a pin is a request to keep a project current, not to
 * index a directory. A seed still queued on the builder is logged and retried
 * on the next pass. The copy goes only where no database file is in the way: over
 * an unusable `codegraph.db` the seed answers `failed`, and that is logged. Without a
 * `seed` dependency a root with no index is skipped.
 *
 * Unpinning needs nothing from the opener: the project stays cached with the
 * time it was opened, and the handler's idle release closes it once it has been
 * idle past CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS (the engine re-runs that trim
 * after each housekeeping pass, because no call arms it).
 */
import * as fs from 'fs';
import { isInitialized } from '../../../directory';
import { gitRootByStat } from '../server/index-root';
import { listRegisteredProjects, PROJECT_FLAG_PINNED } from './project-registry';
// Type only: the opener does not load seed.ts at runtime (the builder does the seeding).
import type { WorktreeSeedOutcome } from './seed';

/** What the opener needs from the engine's tool handler, and where it logs. */
export interface PinnedOpenerDeps {
  /**
   * True when `root` is open AND held: the handler caches it and the builder
   * reports a hold on it. Open alone is not enough: if the first `ensure` answered
   * `none` (the builder not up in time, an IPC failure) the handler still caches
   * the root read-only while the builder records no hold, so the root would be
   * open but never watched or synced. A root that is not both gets `open` again,
   * which re-asks the builder. The builder's report is its last push, so between a
   * successful ensure and the first push it can be missing: the cost is one more
   * idempotent ensure on the next pass.
   */
  isOpen(root: string): boolean;
  /** Open `root` the way a tool call that names it would, with no call. Rejects with the reason it could not. */
  open(root: string): Promise<void>;
  /** One log line, without a trailing newline. */
  log(line: string): void;
  /** The roots of the pinned projects. Default: the registry's. An unreadable registry yields none. */
  listPinned?(): string[];
  /**
   * Give `root`, which has no index, one copied from its nearest indexed sibling
   * worktree; never a cold build. Optional: without it a root with no index is
   * skipped. A rejection reads as a failed seed.
   */
  seed?(root: string): Promise<WorktreeSeedOutcome>;
}

/**
 * Characters of a reason kept in a log line (an error message can run to a
 * paragraph); a longer one is cut to this many and "..." is appended.
 */
const MAX_REASON_CHARS = 240;

function pinnedRootsFromRegistry(): string[] {
  try {
    return listRegisteredProjects()
      .filter((rec) => (rec.flags & PROJECT_FLAG_PINNED) !== 0)
      .map((rec) => rec.root);
  } catch {
    return [];
  }
}

function reasonOf(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}...` : text;
}

export class PinnedProjectOpener {
  // The pass in flight, so an overlapping call awaits it instead of starting a second
  // one: two passes would race to open the same root.
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  // The last reason logged for each root. A root that stays unopenable is retried every
  // pass, and one line a minute about it would drown the log, so the same reason is not
  // logged twice in a row for a root; a different reason logs at once. The entry is
  // dropped when the root opens or stops being pinned, so a later failure of the same
  // root logs again.
  private lastLogged = new Map<string, string>();

  constructor(private readonly deps: PinnedOpenerDeps) {}

  /**
   * After this, no pass starts another open and no new pass runs: the engine is
   * closing. It stops a pass from STARTING an open only: an open already awaiting
   * the builder's `ensure` may still complete, and the handler's trailing trim
   * releases the project it cached while the handler is closing.
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * One pass: open every pinned root that is not open and held, seeding first one
   * that has no index when the opener has a `seed`. A root in no git worktree is skipped. Never rejects. A pass already running is awaited, not repeated.
   */
  pass(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.inFlight) {
      this.inFlight = this.run().finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  private async run(): Promise<void> {
    let roots: string[];
    try {
      roots = (this.deps.listPinned ?? pinnedRootsFromRegistry)();
    } catch {
      return; // an unreadable registry pins nothing
    }
    const pinned = new Set(roots);
    for (const root of this.lastLogged.keys()) {
      if (!pinned.has(root)) this.lastLogged.delete(root);
    }
    // One root at a time: after a restart every pinned root is opened, and each open
    // queues a hold and a catch-up on the builder, which must not be flooded at once.
    for (const root of roots) {
      if (this.stopped) return;
      if (this.deps.isOpen(root)) {
        this.lastLogged.delete(root);
        continue;
      }
      const skip = unopenableReason(root);
      if (skip === NO_INDEX && this.deps.seed) {
        if (!(await this.seedRoot(root, this.deps.seed))) continue;
        // The engine may have closed while the seed ran.
        if (this.stopped) return;
      } else if (skip !== null) {
        this.note(root, `skipped: ${skip}`);
        continue;
      }
      try {
        await this.deps.open(root);
        this.lastLogged.delete(root);
      } catch (err) {
        this.note(root, `not opened: ${reasonOf(err)}`);
      }
    }
  }

  /**
   * Seed `root` and log the outcome. True when the root now has an index and is
   * to be opened (`indexed`, `seeded`); false when it is skipped this pass.
   */
  private async seedRoot(root: string, seed: (root: string) => Promise<WorktreeSeedOutcome>): Promise<boolean> {
    let outcome: WorktreeSeedOutcome;
    try {
      outcome = await seed(root);
    } catch (err) {
      outcome = { kind: 'failed', root, reason: err instanceof Error ? err.message : String(err) };
    }
    switch (outcome.kind) {
      case 'indexed':
        return true;
      case 'seeded':
        this.note(root, `seeded from ${outcome.source} (${outcome.method})`);
        return true;
      case 'no-source':
        this.note(root, 'skipped: no index and no sibling worktree has one');
        return false;
      case 'not-git':
        this.note(root, 'skipped: no index, and it is not in a git worktree (a pin never builds one)');
        return false;
      case 'disabled':
        this.note(root, 'skipped: no index (automatic seeding is off: CODEGRAPH_NO_AUTO_SEED=1)');
        return false;
      case 'queued':
        this.note(root, 'not opened yet: its seed is queued on the index builder');
        return false;
      case 'failed':
        this.note(root, `not seeded: ${reasonOf(outcome.reason)}`);
        return false;
      default:
        return false;
    }
  }

  /** Log `[CodeGraph MCP] Pinned project <root> <what>` unless that exact line was the root's last. */
  private note(root: string, what: string): void {
    if (this.lastLogged.get(root) === what) return;
    this.lastLogged.set(root, what);
    try {
      this.deps.log(`[CodeGraph MCP] Pinned project ${root} ${what}`);
    } catch {
      /* a failing log sink must not stop the pass */
    }
  }
}

/** unopenableReason's answer for a directory with no index (isInitialized false): the one a seed can cure. */
const NO_INDEX = 'no index';

/**
 * Why `root` must not be opened as it is, or null. A directory that is gone has
 * nothing to hold (the builder's sweep tears its registration down on its own
 * schedule), nor does a path that exists but is not a directory; a root with no
 * git worktree and no opted-in folder (`codegraph init <dir> --no-git`) at or
 * above it is never served, so it is refused before its index is looked at, and
 * a seed never sees it; a root in either with no
 * index ({@link NO_INDEX}: isInitialized is false, so a missing, empty, schema-less
 * or foreign `codegraph.db` alike) goes to the opener's `seed` when it has one, and
 * is never built from here. The seed copies only where no database file is in the
 * way: an unusable `codegraph.db` stays, and the seed answers `failed`.
 */
function unopenableReason(root: string): string | null {
  try {
    if (!fs.statSync(root).isDirectory()) return 'not a directory';
  } catch {
    return 'directory is gone';
  }
  if (gitRootByStat(root) === null) return 'not in a git worktree';
  if (!isInitialized(root)) return NO_INDEX;
  return null;
}
