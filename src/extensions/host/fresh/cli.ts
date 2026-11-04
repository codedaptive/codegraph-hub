/**
 * `--fresh` / `--checkpoint` on the commands that answer from the index (query, explore, node, callers,
 * callees, impact), and the `checkpoint` command's action. The checkpoint says which state of the
 * workspace the answer reflects; see ./checkpoint.
 *
 * Loaded only with `await import`: by the six commands' hook in src/bin/codegraph.ts, and by the
 * `checkpoint` command that ../extension.ts registers. Each of the six commands calls startFresh before
 * openIndexToRead, fresh.end in place of cg.destroy(), and fresh.fail in its catch:
 *
 *   fresh = await (await import('../extensions/host/fresh/cli')).startFresh(projectPath, options, loadCodeGraph);
 *   const cg = await openIndexToRead(projectPath);
 *   ... answer ...
 *   await fresh.end(cg[, finishWith]);   // see FreshAnswer.end for finishWith
 *   ... catch: await fresh?.fail();
 *
 * src/bin/codegraph.ts passes its own loadCodeGraph, so a module load failure prints the same banner
 * and exits 1 as without the flags. explore and node do not pass `fresh` / `checkpoint` into the MCP
 * tool's args: the wait already ran here, and the checkpoint goes to stderr rather than into the tool's
 * text.
 */
import * as path from 'path';
import type { CodeGraph } from '../../../index';
import { isInitialized } from '../../../directory';
import { getGlyphs } from '../../../ui/glyphs';
import {
  formatCheckpointJson, formatCheckpointText, readCheckpoint, resolveFreshSettleTimeoutMs,
  waitForFreshTracked, type AnswerCheckpoint,
} from './checkpoint';
import { EXIT_NOT_FRESH, type FreshFlags } from './options';
import type { SyncWriter } from '../builder/cli-route';

/** Loads the engine; src/bin/codegraph.ts's loadCodeGraph (banner and exit 1 on failure). */
export type LoadCodeGraph = () => Promise<typeof import('../../../index')>;

/**
 * Run after the answer and its checkpoint are printed, and before any process.exit. Never rejects; a
 * second call returns the first call's promise. `exitCode` is the status to exit with if the settle cap
 * passes (default: process.exitCode, else 0).
 */
type FreshFinish = (exitCode?: number) => Promise<void>;

const NOTHING_TO_FINISH: FreshFinish = async () => {};

/**
 * What the `--fresh` wait produced: its checkpoint, or why the writable index could not be opened; and
 * `finish`, which closes the writable index once the sync the wait started has settled.
 */
type FreshWait = (
  | { checkpoint: AnswerCheckpoint }
  | { syncError: string }
) & { finish: FreshFinish };

/** One command's `--fresh` / `--checkpoint` handling, from startFresh. */
export interface FreshAnswer {
  /**
   * After the answer is printed, in place of `cg.destroy()`: reads the checkpoint on `cg` (answerCheckpoint),
   * destroys `cg`, prints the checkpoint (emitCheckpoint), then finishes the `--fresh` wait with
   * `finishWith` as its exit status should the settle cap pass. `finishWith: false` skips the finish, for
   * a `finally` reached by a throw: the command's catch prints its error first and then calls fail().
   */
  end(cg: CodeGraph, finishWith?: number | false): Promise<void>;
  /** From the command's catch, after its error line: finish the `--fresh` wait with exit status 1. */
  fail(): Promise<void>;
}

/**
 * The hook the six commands call after their isInitialized check and before openIndexToRead: runs the
 * `--fresh` wait (freshBeforeAnswer) and returns what the command calls once the answer is printed.
 * Without either flag, end() is exactly `cg.destroy()` and fail() does nothing.
 */
export async function startFresh(
  projectPath: string, flags: FreshFlags, loadCodeGraph: LoadCodeGraph,
): Promise<FreshAnswer> {
  const wait = await freshBeforeAnswer(projectPath, flags, loadCodeGraph);
  return {
    async end(cg, finishWith) {
      const cp = await answerCheckpoint(cg, flags, wait);
      cg.destroy();
      await emitCheckpoint(cp, flags);
      if (finishWith !== false) await wait?.finish(finishWith);
    },
    async fail() {
      await wait?.finish(1);
    },
  };
}

/**
 * The `--fresh` wait, run BEFORE openIndexToRead. openIndexToRead's instance is read-only and cannot
 * sync, so the wait syncs on its own. With a machine server whose index builder is up, each sync is a sync
 * job on that builder (../builder/cli-route), the process that owns the index's writes, and this
 * process holds a read-only instance only, to count the pending files. Otherwise the wait runs on its own
 * writable CodeGraph. The answer itself is read exactly as without the flag. waitForFreshTracked retries a
 * held write lock (a daemon mid-sync) within its time bound.
 *
 * The bound counts for the answer, not for process exit. The instance stays open while the answer is read
 * and printed, and the returned `finish` waits for a sync still running at the bound to settle before
 * destroying it (finishFreshWait): closing it earlier would cut a sync running in this process and leave
 * its files pending for the next caller. (A sync running in the builder is not this process's to cut:
 * dropping the connection leaves it to finish.) Undefined without `--fresh`.
 */
async function freshBeforeAnswer(
  projectPath: string, flags: FreshFlags, loadCodeGraph: LoadCodeGraph,
): Promise<FreshWait | undefined> {
  if (!flags.fresh) return undefined;
  let writer: CodeGraph;
  let routed: SyncWriter | null = null;
  try {
    const { default: CodeGraph } = await loadCodeGraph();
    const { openRoutedSync } = await import('../builder/cli-route');
    routed = await openRoutedSync(projectPath);
    writer = await CodeGraph.open(projectPath, routed ? { readOnly: true } : {});
  } catch (err) {
    routed?.destroy();
    return { syncError: syncErrorText(err), finish: NOTHING_TO_FINISH };
  }
  // What finishFreshWait closes: the instance and, when the syncs go to the builder, the connection.
  const open: Closable = { destroy: () => { try { writer.destroy(); } finally { routed?.destroy(); } } };
  try {
    const { checkpoint, settled } = await waitForFreshTracked(writer, {
      sync: () => (routed ? routed.sync() : writer.sync()),
    });
    let finishing: Promise<void> | undefined;
    const finish: FreshFinish = (exitCode) => (finishing ??= finishFreshWait(open, settled, exitCode, routed !== null));
    return { checkpoint, finish };
  } catch (err) {
    // waitForFreshTracked returns, rather than throws, for every expected condition. A throw is a
    // malfunction with no sync outcome left to track, so the instance is closed here.
    open.destroy();
    return { syncError: syncErrorText(err), finish: NOTHING_TO_FINISH };
  }
}

/** What the `--fresh` wait holds open until its sync has settled. */
interface Closable {
  destroy(): void;
}

/**
 * The syncError text for a failed `--fresh` wait: the error's message, or 'could not open the index to
 * sync' when it has none. The answer is still printed, with this text in its checkpoint.
 */
function syncErrorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)) || 'could not open the index to sync';
}

/**
 * Wait for the `--fresh` wait's sync to settle, capped by CODEGRAPH_FRESH_SETTLE_TIMEOUT_MS (see
 * resolveFreshSettleTimeoutMs for the default and the ceiling), then destroy `writer`, the wait's
 * instance (and, when the syncs went to the builder, its connection).
 * Already settled (the wait's sync finished, or it started none): destroyed at once.
 *
 * Cap passed with the sync still running: `writer` is NOT closed, since that would cut a sync running in
 * this process mid-write. One stderr line says so, and the process exits with `exitCode` without closing the index,
 * leaving it as a crash would. A sync's transactions are never left half-applied: SQLite rolls back one
 * that is open at exit, including the synthesis publish, which stays open across yields. A file stored in
 * chunks has no files-table row until its last chunk, so it re-indexes. The next writer reclaims the lock
 * this dead pid leaves (FileLock). The files the sync did not reach stay pending for the next sync.
 * When `routed` (the syncs go to the builder), the sync is the builder's and keeps running there after this
 * process exits, so the stderr line says that instead.
 *
 * The cap timer is cleared once the race is decided, so it never holds the process open after the sync
 * settles. `settled` never rejects and a destroy error is swallowed, so this never rejects either.
 */
async function finishFreshWait(writer: Closable, settled: Promise<void>, exitCode?: number, routed = false): Promise<void> {
  const capMs = resolveFreshSettleTimeoutMs(process.env.CODEGRAPH_FRESH_SETTLE_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<'cap'>(resolve => { timer = setTimeout(() => resolve('cap'), capMs); });
  const result = await Promise.race([settled.then(() => 'settled' as const), cap]);
  clearTimeout(timer);
  if (result === 'settled') {
    try {
      writer.destroy();
    } catch {
      // The answer and its checkpoint are already out and the process is about to exit, which releases
      // the connection and the lock regardless; a close error changes neither.
    }
    return;
  }
  process.stderr.write(
    `The sync started by --fresh is still running after CODEGRAPH_FRESH_SETTLE_TIMEOUT_MS (${capMs} ms); ` +
    (routed
      ? 'exiting; the sync keeps running in the CodeGraph server\'s index builder.\n'
      : 'exiting without closing the index, so the files it did not reach are left for the next sync.\n'),
  );
  process.exit(exitCode ?? (typeof process.exitCode === 'number' ? process.exitCode : 0));
}

/**
 * The checkpoint to report for this answer, read before `cg` is destroyed: the `--fresh` wait's own,
 * else a no-wait read on the read-only instance (getChangedFiles only reads). Undefined when neither
 * flag was given.
 */
async function answerCheckpoint(
  cg: CodeGraph, flags: FreshFlags, wait: FreshWait | undefined,
): Promise<AnswerCheckpoint | undefined> {
  if (wait && 'checkpoint' in wait) return wait.checkpoint;
  if (!flags.fresh && !flags.checkpoint) return undefined;
  const cp = await readCheckpoint(cg);
  if (wait) cp.syncError = wait.syncError;
  return cp;
}

/**
 * After the answer: the checkpoint as ONE `codegraph-checkpoint <json>` line on stderr, so stdout (a
 * `--json` answer included) is unchanged. A `--fresh` that ended not fresh also gets the `Note:` line
 * (formatCheckpointText's second line, saying why) on stderr, and sets exit status 3; the commands' own
 * exit(1) paths for errors still win. Both lines are written before the FreshWait's finish, so they are
 * out while any settle wait runs.
 */
async function emitCheckpoint(cp: AnswerCheckpoint | undefined, flags: FreshFlags): Promise<void> {
  if (!cp) return;
  // Fixed prefix: stderr also carries warnings, and the prefix lets a script pick this one line out.
  process.stderr.write(`codegraph-checkpoint ${formatCheckpointJson(cp)}\n`);
  if (flags.fresh && !cp.fresh) {
    writeNotFreshNote(cp);
    process.exitCode = EXIT_NOT_FRESH;
  }
}

/**
 * The `Note:` line saying why a `--fresh` checkpoint is not fresh (formatCheckpointText's second line),
 * on stderr. Shared by emitCheckpoint and `checkpoint --json`, so the wording lives in one place.
 */
function writeNotFreshNote(cp: AnswerCheckpoint): void {
  const note = formatCheckpointText(cp).split('\n')[1];
  if (note !== undefined) process.stderr.write(`${note}\n`);
}

// ---------------------------------------------------------------------------
// The `checkpoint` command (registered by ../extension.ts)
// ---------------------------------------------------------------------------

/** An error line on stderr: the glyph uncoloured, as the other zones' extension commands print theirs. */
function error(message: string): void {
  console.error(`${getGlyphs().err} ${message}`);
}

/**
 * The engine for the `checkpoint` command. The same banner src/bin/codegraph.ts's loadCodeGraph prints
 * on a load failure, with the glyph uncoloured, then exit 1.
 */
async function loadCodeGraphForCheckpoint(): Promise<typeof import('../../../index')> {
  try {
    return await import('../../../index');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${getGlyphs().err} Failed to load CodeGraph modules.`);
    console.error(`\n  Node: ${process.version}  Platform: ${process.platform} ${process.arch}`);
    console.error(`\n  Error: ${msg}`);
    console.error('\n  Try reinstalling with: npm install -g @colbymchenry/codegraph\n');
    process.exit(1);
  }
}

/**
 * Resolve project path from argument or current directory
 * Walks up parent directories to find nearest initialized CodeGraph project
 * (must have .codegraph/codegraph.db, not just .codegraph/lessons.db)
 *
 * The same rule as src/bin/codegraph.ts's private resolveProjectPath, duplicated because that one is not
 * exported.
 */
function resolveProjectPath(pathArg?: string): string {
  const absolutePath = path.resolve(pathArg || process.cwd());

  // If exact path is initialized (has codegraph.db), use it
  if (isInitialized(absolutePath)) {
    return absolutePath;
  }

  // Walk up to find nearest parent with CodeGraph initialized
  let current = absolutePath;
  const root = path.parse(current).root;

  while (current !== root) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;

    if (isInitialized(current)) {
      return current;
    }
  }

  // Not found - return original path (will fail later with helpful error)
  return absolutePath;
}

/**
 * Open the index read-only, as src/bin/codegraph.ts's openIndexToRead does: a read-only instance leaves
 * migrations, index repairs and WAL maintenance to the writer, so it cannot disturb a `codegraph index`
 * or a sync running in another process. During a rebuild the answer comes from a graph still being
 * built, so the command says so, on stderr to keep a `--json` answer parseable (glyph uncoloured).
 */
async function openIndexToRead(projectPath: string): Promise<CodeGraph> {
  const { default: CodeGraph } = await loadCodeGraphForCheckpoint();
  const cg = await CodeGraph.open(projectPath, { readOnly: true });
  const { isRebuildInProgress } = await import('../../../mcp/writer-lock');
  if (isRebuildInProgress(projectPath)) {
    console.error(`${getGlyphs().warn} An index rebuild ("codegraph index") is running in another process — this answer comes from the part of the index it has rebuilt so far.`);
  }
  return cg;
}

/**
 * codegraph checkpoint [path]
 *
 * Which state of the workspace the index reflects: git HEAD, a hash of the
 * uncommitted changes under the project, and how many source files the index
 * has not caught up with. Exit 3 when not fresh: files still pending or the
 * count unknown (a `--fresh` bound that passed leaves files pending). Exit 0
 * when fresh, including a `--fresh` sync error with nothing pending. Exit 1
 * on error or when the project is not initialized. A `--fresh` that ended
 * not fresh prints the `Note:` saying why: in the text output, or on stderr
 * with `--json`. All of it is printed before any wait for the sync to settle.
 */
export async function runCheckpointCommand(
  pathArg: string | undefined, options: { fresh?: boolean; json?: boolean },
): Promise<void> {
  const projectPath = resolveProjectPath(pathArg);
  let wait: FreshWait | undefined;

  try {
    if (!isInitialized(projectPath)) {
      error(`CodeGraph not initialized in ${projectPath}`);
      process.exit(1);
    }

    wait = await freshBeforeAnswer(projectPath, options, loadCodeGraphForCheckpoint);
    let cp = wait && 'checkpoint' in wait ? wait.checkpoint : undefined;
    if (!cp) {
      // No wait, or its open failed: read it from the read-only index.
      const cg = await openIndexToRead(projectPath);
      try {
        cp = await answerCheckpoint(cg, { ...options, checkpoint: true }, wait);
      } finally {
        cg.destroy();
      }
    }
    // Text output carries the Note as its second line; JSON keeps stdout one object, so the Note goes to
    // stderr. Either way it is out before finish, while a sync still running at the bound settles.
    console.log(options.json ? formatCheckpointJson(cp!) : formatCheckpointText(cp!));
    if (options.json && options.fresh && !cp!.fresh) writeNotFreshNote(cp!);
    process.exitCode = cp!.fresh ? 0 : EXIT_NOT_FRESH;
    await wait?.finish();
  } catch (err) {
    error(`Checkpoint failed: ${err instanceof Error ? err.message : String(err)}`);
    await wait?.finish(1);
    process.exit(1);
  }
}
