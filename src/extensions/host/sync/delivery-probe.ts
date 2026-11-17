/**
 * macOS watcher delivery probe for the host's catch-up readiness gate.
 * It lives in the host extension so the upstream watcher remains policy-neutral.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { codeGraphDirNameFor } from '../../../directory';
import { logDebug, logWarn } from '../../../errors';
import type { ReadinessGate, ReadinessGateFactory } from '../../../sync/watcher';
import { normalizePath } from '../../../utils';

/** Below waitUntilReady's 10000ms default so the probe can fall back first. */
export const DEFAULT_DELIVERY_PROBE_MAX_MS = 5000;

/** Opt-in delivery readiness for macOS; other platforms are ready at installation. */
export function deliveryProbeGate(options?: { maxMs?: number }): ReadinessGateFactory {
  return (projectRoot) => process.platform === 'darwin'
    ? new DeliveryProbe(projectRoot, options?.maxMs ?? DEFAULT_DELIVERY_PROBE_MAX_MS)
    : null;
}

class DeliveryProbe implements ReadinessGate {
  private probe: { path: string; relativePath: string; fd: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private bound: ReturnType<typeof setTimeout> | null = null;
  private onConfirm: (() => void) | null = null;
  private confirmed = false;

  constructor(private readonly projectRoot: string, private readonly maxMs: number) {}

  /**
   * FSEvents starts with since-now semantics on a separate thread. Repeated
   * descriptor-only touches every 50ms give the stream opportunities to show
   * delivery without following a replaced probe path. Creation failure or the
   * timeout confirms the gate without proving delivery; touch failures retry
   * until the timeout.
   */
  start(confirm: () => void): void {
    this.onConfirm = confirm;
    try {
      this.createProbe();
    } catch (error) {
      logDebug('Could not create watcher delivery probe; delivery unproven', { error: String(error) });
      this.confirm();
      return;
    }
    this.timer = setInterval(() => {
      if (!this.probe) return;
      try {
        const now = new Date();
        fs.futimesSync(this.probe.fd, now, now);
      } catch (error) {
        logDebug('Could not touch watcher delivery probe', { error: String(error) });
      }
    }, 50);
    this.timer.unref();
    this.bound = setTimeout(() => {
      logWarn('Watcher delivery probe timed out; delivery unproven', {
        projectRoot: this.projectRoot,
        deliveryProbeMaxMs: this.maxMs,
      });
      this.confirm();
    }, this.maxMs);
    this.bound.unref();
  }

  claims(relativePath: string): boolean {
    if (this.probe?.relativePath !== relativePath) return false;
    this.confirm();
    return true;
  }

  private createProbe(): void {
    const dataDir = path.join(this.projectRoot, codeGraphDirNameFor(this.projectRoot));
    let dir = this.projectRoot;
    try {
      // The root stream cannot see inside a data-directory symlink to elsewhere.
      if (fs.lstatSync(dataDir).isDirectory()) dir = dataDir;
    } catch { /* missing or inaccessible: probe the project root */ }
    // Exclusive creation never replaces someone else's entry. Retry a few UUID
    // collisions, but keep startup bounded if a name cannot be claimed.
    for (let attempt = 0; attempt < 3; attempt++) {
      const probePath = path.join(dir, `.codegraph-watch-probe-${randomUUID()}`);
      try {
        this.probe = {
          path: probePath,
          relativePath: normalizePath(path.relative(this.projectRoot, probePath)),
          fd: fs.openSync(probePath, 'wx', 0o600),
        };
        return;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue;
        throw error;
      }
    }
    throw new Error('Could not claim a watcher delivery probe name');
  }

  private confirm(): void {
    if (this.confirmed) return;
    this.confirmed = true;
    const confirm = this.onConfirm;
    this.stop();
    confirm?.();
  }

  /**
   * Unlink only after checking for a regular file matching our descriptor. The
   * check-then-unlink narrows but does not eliminate a replacement race. No
   * stale sweep: a process killed mid-probe can leave one empty probe file,
   * ignored by both the indexer and watcher through its `.codegraph-*` name.
   */
  stop(): void {
    clearInterval(this.timer ?? undefined);
    clearTimeout(this.bound ?? undefined);
    this.timer = null;
    this.bound = null;
    this.onConfirm = null;
    const probe = this.probe;
    this.probe = null;
    if (!probe) return;
    try {
      const owned = fs.fstatSync(probe.fd);
      const current = fs.lstatSync(probe.path);
      if (current.isFile() && owned.dev === current.dev && owned.ino === current.ino) fs.unlinkSync(probe.path);
    } catch { /* removed, replaced or inaccessible: leave it alone */ }
    try { fs.closeSync(probe.fd); } catch { /* cleanup is best effort */ }
  }
}
