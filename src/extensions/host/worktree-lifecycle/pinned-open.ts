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
 * read-only. The server writes nothing here, and a root with no index is never
 * given one: the opener skips it rather than cold-building it, because a pin is
 * a request to keep an existing project current, not to index a directory.
 *
 * Unpinning needs nothing from the opener: the project stays cached with the
 * time it was opened, and the handler's idle release closes it once it has been
 * idle past CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS (the engine re-runs that trim
 * after each housekeeping pass, because no call arms it).
 */
import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../../../directory';
import { listRegisteredProjects, PROJECT_FLAG_PINNED } from './project-registry';

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
   * One pass: open every pinned root that has an index and is not open and held. Never
   * rejects. A pass already running is awaited, not repeated.
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
      if (skip !== null) {
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

/**
 * Why `root` must not be opened, or null. A directory that is gone has nothing
 * to hold (the builder's sweep tears its registration down on its own
 * schedule), nor does a path that exists but is not a directory; a root with no
 * database is never built from here.
 */
function unopenableReason(root: string): string | null {
  try {
    if (!fs.statSync(root).isDirectory()) return 'not a directory';
  } catch {
    return 'directory is gone';
  }
  if (!fs.existsSync(path.join(getCodeGraphDir(root), 'codegraph.db'))) return 'no index';
  return null;
}
