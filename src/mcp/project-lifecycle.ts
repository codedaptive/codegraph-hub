/** Shared synchronization ownership for projects accessed by MCP engines (#1835). */
import { realpathSync } from 'fs';
import * as path from 'path';
import type CodeGraph from '../index';
import { canonicalProjectRoot, getCodeGraphDir, isInitialized } from '../directory';
import { LockUnavailableError, watchDisabledReason } from '../sync';
import { addWatchdogProgressPaths } from './liveness-watchdog';
import { markWriterReady, readWriterLock, releaseWriterLock, tryAcquireWriterLock } from './writer-lock';

interface Project {
  /** Identity key: one entry however the root is spelled (#2278). */
  key: string;
  cg: CodeGraph;
  refs: number;
  owner: boolean;
  caughtUp: boolean;
  retirement: Promise<void> | null;
  gate: Promise<void> | null;
  timer: NodeJS.Timeout;
  options: Parameters<CodeGraph['watch']>[0];
  /** Drops the index files from the liveness watchdog's progress; set while this process writes them (#2404). */
  dropProgress: (() => void) | null;
}

export interface ProjectLease {
  cg: CodeGraph;
  ready(): Promise<void>;
  release(): Promise<void>;
}

const projects = new Map<string, Project>();

/** Engines in one process share a graph; other processes share the writer slot. */
export function acquireProject(
  root: string,
  open: () => CodeGraph,
  options: Parameters<CodeGraph['watch']>[0],
): ProjectLease {
  root = realpathSync(root);
  const key = canonicalProjectRoot(root);
  let project = projects.get(key);
  if (!project) {
    const cg = open();
    project = { key, cg, refs: 0, owner: false, caughtUp: false, retirement: null, gate: null, options,
      dropProgress: null, timer: setInterval(() => { void ready(root, project!); }, 1000) };
    project.timer.unref();
    projects.set(key, project);
  }
  const entry = project;
  entry.refs++;
  let released = false;
  return {
    cg: entry.cg,
    ready: () => ready(root, entry),
    release: () => {
      if (released) return Promise.resolve();
      released = true;
      if (--entry.refs === 0) return retire(root, entry);
      return Promise.resolve();
    },
  };
}

function retire(root: string, project: Project): Promise<void> {
  if (project.retirement) return project.retirement;
  let resolve!: () => void;
  const retirement = new Promise<void>((done) => { resolve = done; });
  project.retirement = retirement;
  clearInterval(project.timer);
  // A timed-out gate or an already-running watcher sync still owns this DB.
  // Leave the entry discoverable so a new lease can reuse it while it drains.
  const finish = (): void => {
    if (project.refs > 0) {
      project.retirement = null;
      project.timer = setInterval(() => { void ready(root, project); }, 1000);
      project.timer.unref();
      resolve();
      return;
    }
    if (project.gate || project.cg.isIndexing()) {
      setTimeout(finish, 25);
      return;
    }
    projects.delete(project.key);
    project.cg.close();
    if (project.owner) releaseWriterLock(root);
    // After the close, which may still checkpoint the WAL on this thread.
    project.dropProgress?.();
    project.dropProgress = null;
    resolve();
  };
  finish();
  return retirement;
}

function ready(root: string, project: Project): Promise<void> {
  if (project.gate) return project.gate;
  if (project.refs === 0 || (project.owner && project.caughtUp)) {
    return Promise.resolve();
  }
  const gate = activate(root, project).catch((err) => {
    // A CLI/indexer can hold codegraph.lock even while we own writer.pid.
    // Leave caughtUp false so the next access or timer retries quietly (#1361).
    if (err instanceof LockUnavailableError) return;
    process.stderr.write(`[CodeGraph MCP] Catch-up sync failed for ${root}: ${err instanceof Error ? err.message : String(err)}\n`);
  }).finally(() => {
    if (project.gate === gate) project.gate = null;
  });
  project.gate = gate;
  return gate;
}

async function activate(root: string, project: Project): Promise<void> {
  if (!isInitialized(root)) return;
  // Rebuild what an interrupted bulk load dropped (off this thread, #1887)
  // before writing: a sync's writes would wait out the rebuild's write lock
  // with this thread blocked.
  if (project.cg.hasPendingIndexRecovery?.()) await project.cg.recoverIndexes();
  const writer = tryAcquireWriterLock(root, 'fallback');
  if (writer.kind === 'taken') {
    // Another process owns this project's updates (a CLI watcher, a server of
    // another state dir, another session's engine). It cannot take RPC from us,
    // but it advertises completion in writer.pid: wait for its startup
    // reconcile, and answer reads from the shared WAL meanwhile. Legacy writers
    // have no readiness flag. The periodic retry takes over when it exits.
    const deadline = Date.now() + 30_000;
    while (project.refs > 0 && writer.existing?.ready === false && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const current = readWriterLock(root);
      if (!current || current.pid !== writer.existing.pid) return activate(root, project);
      if (current.ready !== false) break;
      try { process.kill(current.pid, 0); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return activate(root, project);
      }
    }
    return;
  }
  project.owner = true;
  // This process writes the index from here on, in long synchronous stretches
  // on the main thread: the catch-up below and every watcher sync. The
  // liveness watchdog must count its files advancing as progress, as it does
  // for the project it was armed with; otherwise a long sync of any other
  // project reads as a wedge and the server is killed mid-sync (#2404).
  if (!project.dropProgress) {
    const db = path.join(getCodeGraphDir(root), 'codegraph.db');
    project.dropProgress = addWatchdogProgressPaths([db, `${db}-wal`]);
  }
  const disabled = watchDisabledReason(root);
  if (disabled) {
    process.stderr.write(`[CodeGraph MCP] File watcher disabled for ${root} — ${disabled}.\n`);
  } else {
    if (project.cg.watch(project.options)) {
      process.stderr.write(`[CodeGraph MCP] File watcher active for ${root} — graph will auto-sync on changes\n`);
    }
  }
  await project.cg.sync();
  project.caughtUp = true;
  markWriterReady(root);
}
