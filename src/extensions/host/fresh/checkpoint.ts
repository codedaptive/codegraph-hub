/**
 * Answer checkpoints: which state of the workspace an answer reflects (git HEAD, a content hash of the
 * uncommitted changes, how many source files the index has not caught up with), the bounded `fresh`
 * wait that syncs the index first, and the text the MCP footer and the CLI print.
 *
 * Used by the MCP ToolHandler (src/mcp/tools.ts: the `fresh` / `checkpoint` tool arguments) and by the
 * CLI's `--fresh` / `--checkpoint` flags and `checkpoint` command (./cli.ts). Imports only node
 * built-ins, so it loads nothing of the engine; it matches LockUnavailableError by name for the same
 * reason (see isLockContention).
 */
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { lstatSync, type Stats } from 'fs';

/** The workspace state an answer was built against. */
export interface AnswerCheckpoint {
  /** `git rev-parse HEAD` in the project root; null outside git or on an unborn branch. */
  head: string | null;
  /** Content hash of the uncommitted changes under the project root (see computeUncommittedHash); null when clean, outside git, or when git fails. */
  dirtyHash: string | null;
  /** Source files the index has not caught up with (added + modified + removed); null when unmeasured. */
  pending: number | null;
  /** pending === 0. */
  fresh: boolean;
  /** Time spent waiting for the index; 0 when no wait was asked for. */
  waitedMs: number;
  /** A fresh wait was asked for and the bound passed before the index caught up. */
  timedOut: boolean;
  /**
   * Why the index could not be synced: a sync failure other than lock contention (e.g. the builder's
   * sync job failing), the CLI failing to open the index for writing, or a caller with no sync to run
   * (READ_ONLY_SYNC_ERROR).
   */
  syncError?: string;
}

/**
 * The part of CodeGraph the checkpoint needs to measure (CodeGraph satisfies it). Syncing is not part
 * of it: the caller passes the sync to run (FreshWaitOptions.sync), since the index is written by a
 * different party in each caller (the builder for the MCP server, the CLI's own instance).
 */
export interface CheckpointSource {
  getProjectRoot(): string;
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] };
}

/** 30 s: below common MCP client call timeouts, long enough for an incremental sync. */
export const DEFAULT_FRESH_TIMEOUT_MS = 30_000;
/** A ceiling so a mistyped CODEGRAPH_FRESH_TIMEOUT_MS cannot hang a call. */
const MAX_FRESH_TIMEOUT_MS = 600_000;
/** Pause between sync rounds (lock contention, or a sync that left files pending), so the wait never spins. */
const DEFAULT_POLL_MS = 250;
/** Per git call: a wedged git costs the checkpoint its git fields (null), not the answer. */
const GIT_TIMEOUT_MS = 5000;
/**
 * Blob id recorded for an entry whose working-tree file is gone (a deletion): git's null object id,
 * which no real blob hashes to, so a deletion never collides with content.
 */
const DELETED_BLOB = '0'.repeat(40);

/** CODEGRAPH_FRESH_TIMEOUT_MS: non-negative integer ms, capped at 600000; unset or not all digits -> 30000. */
export function resolveFreshTimeoutMs(raw?: string | undefined): number {
  if (raw === undefined) return DEFAULT_FRESH_TIMEOUT_MS;
  const text = raw.trim();
  // Digits only: a negative, fractional or non-numeric value is invalid, not clamped.
  if (!/^\d+$/.test(text)) return DEFAULT_FRESH_TIMEOUT_MS;
  return Math.min(Number(text), MAX_FRESH_TIMEOUT_MS);
}

/**
 * How long the CLI waits, after printing a `--fresh` answer whose bound passed, for the sync that wait
 * started to settle before it closes the index. 10 minutes: a generous cap on how long the process stays
 * alive after the answer, because closing the writer mid-sync cuts it and leaves the files pending for
 * the next caller. The answer is already printed, so this wait delays only the process exit.
 */
export const DEFAULT_FRESH_SETTLE_TIMEOUT_MS = 600_000;
/** 1 hour: a ceiling so a mistyped CODEGRAPH_FRESH_SETTLE_TIMEOUT_MS cannot keep a CLI process alive indefinitely. */
const MAX_FRESH_SETTLE_TIMEOUT_MS = 3_600_000;

/** CODEGRAPH_FRESH_SETTLE_TIMEOUT_MS: non-negative integer ms, capped at 3600000; unset or not all digits -> 600000. */
export function resolveFreshSettleTimeoutMs(raw?: string | undefined): number {
  if (raw === undefined) return DEFAULT_FRESH_SETTLE_TIMEOUT_MS;
  const text = raw.trim();
  // Digits only, as resolveFreshTimeoutMs: a negative, fractional or non-numeric value is invalid, not clamped.
  if (!/^\d+$/.test(text)) return DEFAULT_FRESH_SETTLE_TIMEOUT_MS;
  return Math.min(Number(text), MAX_FRESH_SETTLE_TIMEOUT_MS);
}

/**
 * git's stdout as raw bytes. Paths stay bytes end to end: decoding them as UTF-8 would turn a name that
 * is not valid UTF-8 into U+FFFD, and that rewritten name no longer opens the file.
 */
function gitBytes(cwd: string, args: string[], input?: Buffer): Buffer {
  return execFileSync('git', args, {
    cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'], input,
    // A dirty tree with many files prints a long status; the default 1 MiB would fail it.
    maxBuffer: 64 * 1024 * 1024,
  });
}

function git(cwd: string, args: string[], input?: Buffer): string {
  return gitBytes(cwd, args, input).toString('utf8');
}

const QUOTE = 0x22; // "
const BACKSLASH = 0x5c; // \
const LF = 0x0a;
/** Bytes below 0x20 (LF, CR, TAB among them) and DEL are octal-escaped in a quoted path. */
const FIRST_PRINTABLE = 0x20;
const DEL = 0x7f;

/**
 * One `git hash-object --stdin-paths` line that names exactly `path`, whatever bytes it holds.
 *
 * hash-object reads stdin a line at a time and rewrites each line before opening it: it splits at LF,
 * strips a trailing CR, and C-unquotes a line that begins with `"`. Sent bare, an untracked file named
 * `"a.ts"` would be read as a.ts. So every path is sent C-quoted, which no rewrite can touch: the line
 * begins with `"` and ends with `"` before its LF, `"` and `\` are backslash-escaped, control bytes and
 * DEL become three-digit octal escapes (`\012` for LF), and every other byte, UTF-8 included, passes
 * through as it is. This is the form git's own unquote reads back to the original bytes.
 */
function stdinPathLine(path: Buffer): Buffer {
  const out: number[] = [QUOTE];
  for (const b of path) {
    if (b === QUOTE || b === BACKSLASH) out.push(BACKSLASH, b);
    else if (b < FIRST_PRINTABLE || b === DEL) {
      out.push(BACKSLASH, ...Buffer.from(b.toString(8).padStart(3, '0'), 'latin1'));
    } else out.push(b);
  }
  out.push(QUOTE, LF);
  return Buffer.from(out);
}

/** `git status -z` entries `XY <path>\0`: the path bytes of each. */
function statusPaths(status: Buffer): Buffer[] {
  const paths: Buffer[] = [];
  for (let at = 0; at < status.length;) {
    const nul = status.indexOf(0, at);
    const end = nul === -1 ? status.length : nul;
    // Three bytes of `XY ` precede the path; --no-renames means no second path follows an entry.
    if (end - at > 3) paths.push(status.subarray(at + 3, end));
    at = end + 1;
  }
  return paths;
}

/**
 * HEAD's sha in `root`, or null on any failure (outside git, unborn branch). Runs git itself rather
 * than calling extraction's getGitHeadSha, which would pull the extraction orchestrator into MCP startup.
 */
export function readGitHead(root: string): string | null {
  try {
    return git(root, ['rev-parse', 'HEAD']).trim() || null;
  } catch {
    return null;
  }
}

/**
 * The repository top-level for `cwd`: the one line `git rev-parse --show-toplevel` prints, without its
 * line end. Throws where git does (outside a work tree).
 *
 * git prints the path unquoted, then LF, so exactly one trailing LF is removed. On POSIX nothing more
 * is: a CR, LF or space before that LF is the last byte of the directory's own name, and dropping it
 * would point every lstat at a directory that does not exist, recording each changed file as deleted.
 * On Windows a path cannot contain CR, so there a CR left before the LF is removed as part of the line
 * end.
 */
function gitTopLevel(cwd: string): string {
  let top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.endsWith('\n')) top = top.slice(0, -1);
  if (process.platform === 'win32' && top.endsWith('\r')) top = top.slice(0, -1);
  return top;
}

/**
 * sha256 over the uncommitted changes under `root`, or null when there are none or `root` is not in git.
 *
 * Content-based on purpose: each changed path contributes the blob id of its working-tree bytes (forty
 * zeros when deleted), never its status letters. Two checkpoints agree when the same paths are reported
 * changed by `git status` (gitignored files excluded) with the same working-tree bytes; a changed
 * submodule counts as changed without its content being hashed. So staging (`git add`) alone does not
 * change the hash.
 *
 * Scoped with `-- .` from the project root, so in a subdir project (#1636) edits elsewhere in the repo
 * do not count. git prints the paths relative to the repo top-level; they are hashed in that form, and
 * `hash-object` runs at the top-level so they resolve.
 *
 * Every filename git can list round-trips: `-z` prints paths unquoted, they are kept as raw bytes, and
 * each is sent to the one batched `hash-object --stdin-paths` call C-quoted (see stdinPathLine), so a
 * name with a leading `"`, a trailing CR or an LF is hashed as that file and no other. Entries sort by
 * their path decoded as UTF-8 (ties, possible only between names that are not valid UTF-8, by bytes),
 * and each contributes its raw path bytes, then `\0<blob>\n`: for a UTF-8 name, `${path}\0${blob}\n`.
 */
export function computeUncommittedHash(root: string): string | null {
  try {
    const status = gitBytes(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.']);
    const paths = statusPaths(status);
    if (paths.length === 0) return null;
    const top = gitTopLevel(root);
    const topPrefix = Buffer.from(`${top}/`);
    const entries = paths.map(bytes => ({ bytes, name: bytes.toString('utf8'), blob: '' }));
    const present: typeof entries = [];
    for (const e of entries) {
      let st: Stats | null;
      try { st = lstatSync(Buffer.concat([topPrefix, e.bytes])); } catch { st = null; }
      if (!st) e.blob = DELETED_BLOB;
      // A directory entry is a changed submodule: hash-object cannot read a
      // directory, so it is recorded as changed without hashing its content.
      else if (st.isDirectory()) e.blob = 'submodule';
      else present.push(e);
    }
    if (present.length > 0) {
      const input = Buffer.concat(present.map(e => stdinPathLine(e.bytes)));
      const ids = git(top, ['hash-object', '--stdin-paths'], input).trim().split('\n');
      if (ids.length !== present.length) return null;
      present.forEach((e, i) => { e.blob = ids[i]!.trim(); });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : Buffer.compare(a.bytes, b.bytes)));
    const hash = createHash('sha256');
    for (const e of entries) {
      hash.update(e.bytes);
      hash.update(`\0${e.blob}\n`);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function countPending(cg: CheckpointSource): number | null {
  try {
    const { added, modified, removed } = cg.getChangedFiles();
    return added.length + modified.length + removed.length;
  } catch {
    return null;
  }
}

function pendingMeasure(
  cg: CheckpointSource, measurePending?: () => Promise<number | null>,
): () => Promise<number | null> {
  return measurePending
    ? async () => { try { return await measurePending(); } catch { return null; } }
    : async () => countPending(cg);
}

function checkpointOf(
  cg: CheckpointSource, pending: number | null, waitedMs: number, timedOut: boolean, syncError?: string,
): AnswerCheckpoint {
  const root = cg.getProjectRoot();
  const cp: AnswerCheckpoint = {
    head: readGitHead(root),
    dirtyHash: computeUncommittedHash(root),
    pending,
    fresh: pending === 0,
    waitedMs,
    timedOut,
  };
  if (syncError !== undefined) cp.syncError = syncError;
  return cp;
}

/** No wait: head, dirtyHash, pending (from opts.measurePending if given, else cg.getChangedFiles()). */
export async function readCheckpoint(
  cg: CheckpointSource, opts: { measurePending?: () => Promise<number | null> } = {},
): Promise<AnswerCheckpoint> {
  const pending = await pendingMeasure(cg, opts.measurePending)();
  return checkpointOf(cg, pending, 0, false);
}

// Matched by name, not instanceof: a value import of sync/watcher would load the watcher on MCP startup.
function isLockContention(err: unknown): boolean {
  return err instanceof Error && err.name === 'LockUnavailableError';
}

/** The syncError of a checkpoint taken without a `sync`: the files are pending and this caller has no way to write the index. */
export const READ_ONLY_SYNC_ERROR = 'this session holds the index read-only';

/** Options of {@link waitForFresh} and {@link waitForFreshTracked}. */
export interface FreshWaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  measurePending?: () => Promise<number | null>;
  /**
   * The sync to run while files are pending: the MCP server's is a sync job on the index builder, the
   * CLI's `--fresh` is one too when a machine server's index builder is up (src/extensions/host/builder/cli-route.ts),
   * otherwise its own writable instance's. Absent when the caller holds the index read-only
   * with no one to sync it for it: the wait then measures pending and never syncs (see waitForFresh).
   */
  sync?: () => Promise<unknown>;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Bounded wait until the index matches the working tree. Always returns a checkpoint; never throws for an
 * expected condition (lock contention, the bound passing, a read-only index).
 *
 * Each round measures pending and, while it is above zero, runs `opts.sync()` raced against the time left:
 *   - LockUnavailableError: another writer holds the lock (a watcher sync, a daemon, `codegraph index`);
 *     that is transient, so sleep pollMs and try again.
 *   - any other sync error (e.g. `attempt to write a readonly database`) will not clear by retrying;
 *     stop and report it as syncError.
 * timeoutMs 0 makes no sync attempt: fresh only if nothing is already pending, else timedOut.
 * No `opts.sync` makes no sync attempt either, and says why: the caller holds the index read-only with
 * no one to write it for it (an engine with no builder). Fresh only if nothing is already pending, else
 * the checkpoint carries {@link READ_ONLY_SYNC_ERROR} as its syncError (so its Note reads "the index
 * could not be synced (...)"), without waiting and without timedOut.
 *
 * The bound is soft. A sync runs long synchronous stretches (parsing, SQLite writes) during which no
 * timer can fire, so the race is decided only at the sync's next yield and the wait can overrun the
 * bound by one such stretch. A sync that loses the race keeps running (it cannot be cancelled); its
 * outcome is already settled into a value, so its rejection is never left unhandled. Nothing here waits
 * for it: a caller that must not close the index under it uses waitForFreshTracked and awaits `settled`
 * (the CLI does). The MCP server does not wait: its sync is a job on the builder, which runs it to the
 * end whatever the server does meanwhile.
 */
export async function waitForFresh(
  cg: CheckpointSource,
  opts: FreshWaitOptions = {},
): Promise<AnswerCheckpoint> {
  return (await waitForFreshTracked(cg, opts)).checkpoint;
}

/**
 * waitForFresh, plus `settled`: resolves (never rejects) once no sync this wait started is still running.
 * Already resolved when none is: the wait returned after its sync finished, or started none. Only the
 * last round's sync can be outstanding, since every earlier round awaited its sync's outcome.
 */
export async function waitForFreshTracked(
  cg: CheckpointSource,
  opts: FreshWaitOptions = {},
): Promise<{ checkpoint: AnswerCheckpoint; settled: Promise<void> }> {
  const settledNow = Promise.resolve();
  const timeoutMs = Math.max(0, opts.timeoutMs ?? resolveFreshTimeoutMs(process.env.CODEGRAPH_FRESH_TIMEOUT_MS));
  const pollMs = Math.max(0, opts.pollMs ?? DEFAULT_POLL_MS);
  const measure = pendingMeasure(cg, opts.measurePending);
  const start = Date.now();
  const deadline = start + timeoutMs;
  const done = (pending: number | null, timedOut: boolean, syncError?: string, settled = settledNow) =>
    ({ checkpoint: checkpointOf(cg, pending, Date.now() - start, timedOut, syncError), settled });

  let pending = await measure();
  const sync = opts.sync;
  if (!sync) return done(pending, false, pending === 0 ? undefined : READ_ONLY_SYNC_ERROR);
  if (timeoutMs === 0) return done(pending, pending !== 0);

  for (;;) {
    if (pending === 0) return done(pending, false);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return done(pending, true);

    // Settle the sync into a value up front, so one that loses the race
    // cannot surface later as an unhandled rejection.
    const outcome = Promise.resolve()
      .then(() => sync())
      .then(() => ({ ok: true as const }), (err: unknown) => ({ ok: false as const, err }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), remaining); });
    const result = await Promise.race([outcome, bound]);
    clearTimeout(timer);

    // The sync lost the race and is still running: `settled` follows its outcome, which cannot reject.
    if (result === 'timeout') return done(await measure(), true, undefined, outcome.then(() => undefined));
    if (!result.ok && !isLockContention(result.err)) {
      const message = result.err instanceof Error ? result.err.message : String(result.err);
      return done(await measure(), false, message || 'sync failed');
    }
    pending = await measure();
    // Lock contention, or a sync that left files pending (one that keeps
    // failing to index): pause before the next round rather than spin.
    if (pending !== 0) await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * One text line, plus a `Note:` line when a wait was asked for and the index is not fresh:
 * `Checkpoint: head=<sha|none> dirty=<hash|none> pending=<n|unknown> fresh=<yes|no>`
 * A wait was asked for when any time was spent waiting, the bound passed, or a sync failed.
 */
export function formatCheckpointText(cp: AnswerCheckpoint): string {
  const line = `Checkpoint: head=${cp.head ?? 'none'} dirty=${cp.dirtyHash ?? 'none'} ` +
    `pending=${cp.pending ?? 'unknown'} fresh=${cp.fresh ? 'yes' : 'no'}`;
  const waitAsked = cp.waitedMs > 0 || cp.timedOut || cp.syncError !== undefined;
  if (cp.fresh || !waitAsked) return line;
  const why = cp.syncError !== undefined
    ? `the index could not be synced (${cp.syncError})`
    : 'the index did not catch up within the time bound';
  const count = cp.pending === null
    ? 'an unknown number of files are'
    : `${cp.pending} file${cp.pending === 1 ? ' is' : 's are'}`;
  return `${line}\nNote: ${why}; ${count} pending, and this answer may not reflect them.`;
}

/** One line of JSON, no newline: {"head":..,"dirtyHash":..,"pending":..,"fresh":..,"waitedMs":..,"timedOut":..[,"syncError":..]} */
export function formatCheckpointJson(cp: AnswerCheckpoint): string {
  const out: Record<string, unknown> = {
    head: cp.head, dirtyHash: cp.dirtyHash, pending: cp.pending, fresh: cp.fresh,
    waitedMs: cp.waitedMs, timedOut: cp.timedOut,
  };
  if (cp.syncError !== undefined) out.syncError = cp.syncError;
  return JSON.stringify(out);
}

/**
 * End a successful MCP answer with a Checkpoint line (the last lines of content[0].text) when `fresh` or
 * `checkpoint` was asked for: `freshCp` from ToolHandler.execute's pre-dispatch wait, else read now
 * without waiting. Pending comes from the project's getChangedFiles (the watcher's pending list lags a
 * direct sync). Text only, no structuredContent (#2088). An isError result is returned unchanged.
 * Typed by shape rather than as ToolResult, so this module depends on nothing in src/mcp/tools.ts
 * (which imports it as a value).
 */
export async function appendCheckpointFooter<
  R extends { isError?: boolean; content: Array<{ type: 'text'; text: string }> },
>(result: R, args: Record<string, unknown>, project: CheckpointSource, freshCp?: AnswerCheckpoint): Promise<R> {
  if (result.isError || (freshCp === undefined && args.checkpoint !== true)) return result;
  const [head, ...tail] = result.content;
  if (!head || head.type !== 'text') return result;
  const cp = freshCp ?? await readCheckpoint(project);
  return { ...result, content: [{ ...head, text: `${head.text}\n\n${formatCheckpointText(cp)}` }, ...tail] };
}
