/**
 * The index builder process: the process that writes the indexes the server serves.
 *
 *   node --liftoff-only main.js        (forked by BuilderClient, ./client.ts, with an IPC channel)
 *
 * The server (the machine server, or a direct-mode session) forks one builder and keeps it running. Every
 * cold build, seed copy, sync, watcher sync and VACUUM of every index is a job of this process, and so is every
 * `init`, `index` and `sync` of a codegraph CLI that the server relays (./cli-jobs.ts). Every job runs its body
 * in its own child process (./job-supervisor.ts). The jobs wait on a queue with one lane per git
 * repository plus two shared bypass slots (./queue.ts): each repository runs one job at a time, its short jobs
 * ahead of its cold builds, `init`, `index` and VACUUMs, different repositories run at once, and a busy
 * repository's next job may take a bypass slot while the load average is below 95; the server opens the databases read-only and asks for the rest over IPC (./protocol.ts). The builder has no idle timer of any kind: it lives until its
 * IPC channel closes (the server is gone) or it is signalled.
 *
 * Files in the state dir (CODEGRAPH_STATE_DIR, inherited from the server, else ~/.codegraph):
 *   builder.pid   JSON `{"pid":n,"serverPid":n,"startedAt":"ISO8601"}`, written on start, removed on a clean exit.
 *   builder.log   one line per job edge, appended:
 *                   <ISO8601> job start <kind> <root>
 *                   <ISO8601> job end <kind> <root> ok|failed[: msg]
 *                   <ISO8601> job limit <kind> <root> time|rss <measured> > <max> (<variable>); ended, not retried
 *                 kind is sync (a caller's sync, the server's or the CLI's), catch-up, watch-sync, seed, cold-build,
 *                 init or index (the CLI's, ./cli-jobs.ts), recover, open or vacuum (./vacuum-after-job.ts). Past 4 MiB the file is moved to
 *                 builder.log.1 (replacing an older one) and a new one starts.
 *   builder-ended-jobs.jsonl  one JSON line `{"root","kind","limit","at"}` per job ended over a limit
 *                 (./ended-jobs-file.ts); loaded at start and kept across every restart, so each builder
 *                 refuses those jobs. Only a successful explicit `codegraph index` or `codegraph init` of a root
 *                 removes its lines: one this builder runs (./queue.ts), or one the CLI runs in its own
 *                 process (./clear-ended-root.ts).
 *
 * Exit: when the channel closes (the 'disconnect' event, or a message that cannot be sent because it is
 * already closed: the server may be gone before the first `ready`), the jobs still queued are dropped and a
 * running job gets CODEGRAPH_BUILDER_EXIT_GRACE_MS (default 30 s) to finish; a child still running after it is
 * killed and waited for, and cleaned up as a job ended at a limit is (./end-jobs-after-grace.ts: its seed
 * staging copy, the partial cold build it reported creating, the locks naming it), before the holds are
 * released and the process exits. SIGTERM and SIGINT give no grace: the job children are killed and cleaned up at
 * once, and the process exits after at most 2 s of hold teardown. A
 * killed builder leaves locks that name a dead pid (a CLI index's rebuild lease among them); the next builder
 * reclaims them (writer-lock.ts) and the server's client restarts it. A clean exit releases every rebuild
 * lease (./fences.ts) after the holds.
 *
 * A job over its limit (CODEGRAPH_BUILDER_JOB_MAX_MS, CODEGRAPH_BUILDER_JOB_MAX_RSS_MB; ./job-limits.ts) is ended
 * alone by ./job-limit-guard.ts: its child is killed, the `job limit` line and the job's mark are written, so
 * nothing retries it automatically, a partial cold build it reported creating is rolled back, the locks and seed
 * staging naming the child's pid are removed, and the builder and every other job go on. The watchdog
 * (./job-watchdog.ts) samples every running job every 5 s on the main thread, so it is late while the event loop
 * is blocked; each job is charged its own child's resident size (./read-process-rss.ts).
 *
 * Parse workers run inside `indexAll`, in a job's child, which destroys its pool before it returns; this
 * process's exit path collects garbage first (worker-teardown.ts, "Windows worker crashes") so no marking is in
 * flight when it ends.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseDebounceEnv } from '../../../sync/watch-policy';
import { collectBeforeExit } from '../../../worker-teardown';
import { ensureStateDir } from '../server/state-dir';
import { endJobsAfterGrace } from './end-jobs-after-grace';
import { endedJobs } from './ended-jobs';
import { EndedJobsFile } from './ended-jobs-file';
import { endOverLimit } from './job-limit-guard';
import { resolveJobLimits } from './job-limits';
import { JobSupervisor } from './job-supervisor';
import { JobWatchdog } from './job-watchdog';
import type { BuilderRequest, BuilderToServer } from './protocol';
import { readProcessRssBytes } from './read-process-rss';
import { BuilderService } from './service';

/** Past this size the job log moves to `builder.log.1`. */
const LOG_ROTATE_BYTES = 4 * 1024 * 1024;
const DEFAULT_EXIT_GRACE_MS = 30_000;

/** `CODEGRAPH_BUILDER_EXIT_GRACE_MS`: a non-negative integer; anything else is the default. */
function exitGraceMs(): number {
  const raw = process.env.CODEGRAPH_BUILDER_EXIT_GRACE_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_EXIT_GRACE_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_EXIT_GRACE_MS;
}

/** Appends job lines to `<state dir>/builder.log`, rotating it past {@link LOG_ROTATE_BYTES}. */
class JobLogFile {
  private bytes = 0;

  constructor(private readonly file: string) {
    try { this.bytes = fs.statSync(file).size; } catch { /* no log yet */ }
    if (this.bytes > LOG_ROTATE_BYTES) this.rotate();
  }

  append(line: string): void {
    try {
      const text = `${line}\n`;
      fs.appendFileSync(this.file, text);
      this.bytes += Buffer.byteLength(text);
      if (this.bytes > LOG_ROTATE_BYTES) this.rotate();
    } catch {
      /* a log that cannot be written never stops the builder */
    }
  }

  private rotate(): void {
    try {
      fs.renameSync(this.file, `${this.file}.1`);
    } catch { /* leave it growing rather than lose lines */ return; }
    this.bytes = 0;
  }
}

/** Write `builder.pid` whole: a reader sees the old file or the new, never half of one. */
function writePidFile(file: string, serverPid: number): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const record = { pid: process.pid, serverPid, startedAt: new Date().toISOString() };
  fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Remove `builder.pid` only while it still names this process: a newer builder's file is not ours to delete. */
function removePidFile(file: string): void {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown };
    if (record.pid === process.pid) fs.unlinkSync(file);
  } catch {
    /* gone, or not ours to read */
  }
}

function isRequest(message: unknown): message is BuilderRequest {
  if (message === null || typeof message !== 'object') return false;
  const m = message as { id?: unknown; op?: unknown };
  return typeof m.id === 'number' && typeof m.op === 'string';
}

/** Run the builder in this process, which must have an IPC channel. Never returns normally: it exits. */
export function runBuilder(): void {
  const send = process.send?.bind(process);
  if (!send) {
    process.stderr.write('usage: the index builder is started by the server over an IPC channel (child_process.fork)\n');
    process.exit(2);
  }
  let stateDir: string;
  try {
    stateDir = ensureStateDir();
  } catch (err) {
    process.stderr.write(`index builder: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  const pidFile = path.join(stateDir, 'builder.pid');
  const logFile = new JobLogFile(path.join(stateDir, 'builder.log'));
  const log = (line: string): void => { process.stderr.write(`[CodeGraph builder] ${line}\n`); };

  // Every message goes out with a callback. Without one, a write that fails on a channel the server has
  // already closed (EPIPE, ERR_IPC_CHANNEL_CLOSED) becomes an 'error' event on `process` that nobody
  // listens for, and the unhandled event kills the builder before it removes builder.pid or releases its
  // holds. A send that fails is a disconnect: the same shutdown the 'disconnect' event runs.
  const sendToServer = (message: BuilderToServer): void => {
    try {
      send(message, (err: Error | null) => {
        if (err) shutdown(exitGraceMs());
      });
    } catch {
      shutdown(exitGraceMs());
    }
  };

  const supervisor = new JobSupervisor();
  const service = new BuilderService({
    send: sendToServer,
    jobLog: (line) => logFile.append(line),
    log,
    runJob: (id, spec, onProgress) => supervisor.run(id, spec, onProgress),
    watchOptions: () => ({
      // The debounce override CODEGRAPH_WATCH_DEBOUNCE_MS (issue #403), parsed by watch-policy.ts.
      debounceMs: parseDebounceEnv(process.env.CODEGRAPH_WATCH_DEBOUNCE_MS),
      onSyncComplete: (result) => {
        if (result.filesChanged > 0) log(`Auto-synced ${result.filesChanged} file(s) in ${result.durationMs}ms`);
      },
      onSyncError: (err) => log(`Auto-sync error: ${err.message}`),
      // Live watching gave up for good: say so once. The reason names the remedy.
      onDegraded: (reason) => log(`File watcher degraded — ${reason}`),
    }),
  });

  let stopping = false;
  const shutdown = (graceMs: number): void => {
    if (stopping) return;
    stopping = true;
    // Every job gets the grace; a child still running after it is killed and cleaned up before any hold is
    // released, so none writes to a root after its release.
    void service.stop(graceMs, () => endJobsAfterGrace(supervisor)).finally(() => {
      removePidFile(pidFile);
      // No worker thread should be marking its heap when the process ends (worker-teardown.ts).
      collectBeforeExit();
      process.exit(0);
    });
  };

  // Registered before anything awaits, so a request sent right after the fork is not lost.
  process.on('message', (message: unknown) => {
    if (stopping || !isRequest(message)) return;
    void service.handle(message);
  });
  process.on('disconnect', () => shutdown(exitGraceMs()));
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));

  writePidFile(pidFile, process.ppid);
  const endedFile = new EndedJobsFile(path.join(stateDir, 'builder-ended-jobs.jsonl'));
  const loaded = endedFile.load();
  endedJobs.replaceAll(loaded);
  endedJobs.onClearRoot((root) => endedFile.clearRoot(root));
  for (const job of loaded) log(`refusing ${job.kind} of ${job.root} until \`codegraph index\`: ended over its ${job.limit} limit`);
  const { limits, warnings } = resolveJobLimits();
  for (const warning of warnings) log(warning);
  new JobWatchdog(service.queue, limits, {
    childPid: (jobId) => supervisor.childPid(jobId),
    readChildRssBytes: readProcessRssBytes,
    onBreach: (job, breach, childPid) => void endOverLimit(job, breach, {
      jobLog: (line) => logFile.append(line), endedFile,
      // A getter: the guard reads the identity after the kill has closed the child, so a report the child sent
      // just before the kill is not missed, and the read drops the killed job's entry (./job-supervisor.ts).
      child: { pid: childPid, get createdDatabase() { return supervisor.createdDatabase(job.id); }, kill: () => supervisor.kill(job.id) },
    }),
  }).start();
  service.start();
  sendToServer({ op: 'ready', pid: process.pid } satisfies BuilderToServer);
}

if (require.main === module) runBuilder();
