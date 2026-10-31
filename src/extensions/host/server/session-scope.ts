/**
 * What belongs to ONE session rather than to the machine server: its focus (the directories its results stay
 * inside) and its tool allowlist (the tools it may list and call).
 *
 * One server answers for every client on the machine and takes its process environment from whichever client
 * started it, so a session's focus never comes from the server's own flags or environment, and its allowlist
 * comes from the server's environment only for a legacy client whose hello carries no tool list. Each session
 * carries its own, from its launcher:
 *
 *  - focus: `serve --mcp --focus <dir>` (repeatable). Each `<dir>` is relative to the repository root, so one
 *    spelling means the same directories from any launch directory AND in every git worktree of the repository:
 *    a subagent working in a sibling worktree is held to the same `src/app` inside its own checkout. The
 *    launcher sends the normalised dirs in its client hello and the session keeps them as repo-relative entries
 *    ({@link sessionFocusEntries}); nothing absolute is stored, because the session has no one root. Each call
 *    resolves the entries against the root of the worktree the call's index belongs to
 *    ({@link worktreeRootOf}, {@link resolveFocusForRoot}), and search, explore, callers and impact compare
 *    that index's files against the result ({@link focusPrefixesForIndex}, {@link inFocus}).
 *  - allowlist: the launcher's own `CODEGRAPH_MCP_TOOLS`, sent raw in the same hello and parsed here
 *    ({@link parseToolAllowlist}).
 *
 * Both reach the tool handler as two INTERNAL call arguments ({@link SESSION_FOCUS_ARG},
 * {@link SESSION_TOOLS_ARG}), because a call can cross a structured-clone boundary into a query-pool worker
 * where no handler field or closure follows. The arguments are never accepted from the wire: the one dispatch
 * (`dispatchToolCall`) strips both from every call. It then always sets the focus argument from the session's
 * record, and sets the allowlist argument only when the session was told one.
 *
 * Everything here is a pure function of its inputs apart from the filesystem lookups that canonicalise a
 * directory, so the helpers are unit-testable without a server.
 */
import * as path from 'path';
import { canonicalGitPath, nearestExistingDirectory } from '../worktree-lifecycle/git';
import { gitRootByStat } from './index-root';

/**
 * Internal tool-call argument key: the session's focus as normalised posix directories relative to the
 * repository root (`readonly string[]`, `[]` for no focus). Never accepted from the wire: `dispatchToolCall`
 * strips it from every call and sets it from the session.
 */
export const SESSION_FOCUS_ARG = '__cgSessionFocus';

/**
 * Internal tool-call argument key: the session's tool allowlist as short names (`readonly string[]`, or
 * `null` for a session told it has none). Absent when the session was not told one (a legacy client), in which
 * case the handler falls back to its own process environment. Never accepted from the wire.
 */
export const SESSION_TOOLS_ARG = '__cgSessionTools';

/**
 * A session's tool allowlist as the handler sees it: an array of short names; `null` when the session was
 * told it has no allowlist; `undefined` when the session was not told at all (a legacy client), which makes
 * the handler read `CODEGRAPH_MCP_TOOLS` from its own process environment.
 */
export type SessionToolList = readonly string[] | null | undefined;

/** A `--focus` value the CLI refuses: absolute, escaping the repository root after normalisation, or one too many. */
export class FocusArgError extends Error {}

/**
 * The most `--focus` entries one session may carry. Every focused call canonicalises each entry again
 * ({@link resolveFocusForRoot}, one realpath walk per entry), so the list is bounded: a hello under the 64 KiB
 * line cap could otherwise hold thousands of entries and cost a few hundred milliseconds per call. 64 is far above any real use of
 * "a few directories". The CLI refuses a longer list ({@link normaliseFocusArgs}) and the hello parser drops one
 * (`parseClientHelloLine` in `src/mcp/daemon.ts`).
 */
export const MAX_FOCUS_ENTRIES = 64;

/**
 * Normalise one directory spelled relative to the repository root: posix separators, no trailing slash, `.`
 * segments and doubled slashes collapsed, `..` segments resolved. `.` is the whole repository. Throws
 * {@link FocusArgError} naming `raw` for an absolute path (posix or drive-letter) or one that escapes the root.
 */
function normaliseOne(raw: unknown): string {
  if (typeof raw !== 'string') throw new FocusArgError(`--focus needs a directory, got ${String(raw)}`);
  const slashed = raw.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
    throw new FocusArgError(`--focus ${raw} is an absolute path; give a directory relative to the repository root`);
  }
  // normalize('') is '.', and normalize keeps a trailing slash ('src/' stays 'src/'); the replace below
  // removes it, so 'src/' becomes 'src'.
  const normal = path.posix.normalize(slashed).replace(/\/+$/, '') || '.';
  if (normal === '..' || normal.startsWith('../')) {
    throw new FocusArgError(`--focus ${raw} leaves the repository root; give a directory inside it`);
  }
  return normal;
}

/**
 * Validate and normalise the `--focus` values (relative to the repository root). `.` and the empty string
 * stay `.`: the whole repository, which {@link sessionFocusEntries} reads as no focus. Throws
 * {@link FocusArgError} naming the bad value, for an absolute directory or one that escapes the root, and one
 * naming the cap for more than {@link MAX_FOCUS_ENTRIES} values.
 */
export function normaliseFocusArgs(dirs: readonly string[]): string[] {
  if (dirs.length > MAX_FOCUS_ENTRIES) {
    throw new FocusArgError(`--focus was given ${dirs.length} times; at most ${MAX_FOCUS_ENTRIES} are allowed`);
  }
  return dirs.map(normaliseOne);
}

/**
 * `p` canonicalised even when it does not exist: the nearest existing ancestor's realpath with the missing
 * tail appended, so a symlinked parent of a not-yet-created directory still compares against a canonical root.
 */
function canonicalWithMissingTail(p: string): string {
  const resolved = path.resolve(p);
  const existing = nearestExistingDirectory(resolved);
  if (existing === null) return resolved;
  const tail = path.relative(existing, resolved);
  const base = canonicalGitPath(existing);
  return tail ? path.join(base, tail) : base;
}

/**
 * The session's focus as it is kept: the normalised repo-relative entries of `dirs`, in order, without
 * duplicates. `[]` (no focus) for no list, no entries, or any `.` entry (the whole repository contains every
 * other entry). No anchor and no filesystem: the entries become directories only per call
 * ({@link resolveFocusForRoot}).
 *
 * `dirs` can come off the wire (the client hello), so an entry that is not a string, is absolute or escapes the
 * root is dropped rather than trusted; the valid entries still apply, and a session whose every entry was
 * dropped has no focus (the same `[]` as no `--focus`). Only the first {@link MAX_FOCUS_ENTRIES} entries are
 * read: the CLI refuses a longer list and the hello parser drops one, so the bound only holds this function to
 * its own cost.
 */
export function sessionFocusEntries(dirs: readonly string[] | undefined): string[] {
  if (dirs === undefined) return [];
  const entries: string[] = [];
  for (const raw of dirs.slice(0, MAX_FOCUS_ENTRIES)) {
    let normal: string;
    try {
      normal = normaliseOne(raw);
    } catch {
      continue;
    }
    if (normal === '.') return [];
    if (!entries.includes(normal)) entries.push(normal);
  }
  return entries;
}

/**
 * The canonical root of the git worktree that contains `dir`: the realpath of the nearest directory at or
 * above it with a `.git` entry (a directory for a main checkout, a file for a linked worktree), found by stats
 * alone ({@link gitRootByStat}); `dir`'s own canonical path when it is not inside a git working tree. `dir` is
 * canonicalised first (a missing tail kept), so a symlinked spelling finds the same root as the real one. It is
 * the directory a repo-relative focus entry is relative to for a call answered from an index at `dir`: each
 * linked worktree of a repository is its own root, and an index nested below the root (`repo/sub/.codegraph`)
 * still reads the focus against `repo`.
 */
export function worktreeRootOf(dir: string): string {
  const canonical = canonicalWithMissingTail(dir);
  return gitRootByStat(canonical) ?? canonical;
}

/**
 * The focus `focus` (repo-relative entries, from {@link sessionFocusEntries}) as absolute canonical directories
 * under `root`: the realpath of each entry that exists, and for one that does not exist yet the realpath of its
 * nearest existing ancestor plus the missing tail (the same as {@link canonicalWithMissingTail}). `[]` (no
 * focus) for no entries or any `.` entry.
 *
 * An entry that is not a valid repo-relative directory is dropped, as {@link sessionFocusEntries} drops it. So
 * is an entry that spells a path inside `root` but canonicalises outside it (a symlink in the worktree to `/`
 * or to another directory): it is kept only when its canonical path is the canonical root or lies under it,
 * segment by segment. Kept, a symlink to `/` would be an ancestor of every index root and
 * {@link focusPrefixesFor} would read the session as unfiltered. The check runs per root, so one entry can
 * survive in a worktree and be dropped in a sibling whose entry is a symlink out. A session whose every entry
 * was dropped has no focus here, as with no `--focus`.
 */
export function resolveFocusForRoot(root: string, focus: readonly string[]): string[] {
  const canonicalRoot = canonicalWithMissingTail(root);
  const resolved: string[] = [];
  for (const raw of focus) {
    let normal: string;
    try {
      normal = normaliseOne(raw);
    } catch {
      continue;
    }
    if (normal === '.') return [];
    const abs = canonicalWithMissingTail(path.join(root, ...normal.split('/')));
    if (!isSameOrBelow(canonicalRoot, abs)) continue;
    if (!resolved.includes(abs)) resolved.push(abs);
  }
  return resolved;
}

/**
 * Parse a raw `CODEGRAPH_MCP_TOOLS` value into short tool names: trimmed, the `codegraph_` prefix removed,
 * empty entries dropped. `null` when nothing is left (an empty or blank value): no allowlist.
 */
export function parseToolAllowlist(raw: string): string[] | null {
  const names = raw
    .split(',')
    .map((s) => s.trim().replace(/^codegraph_/, ''))
    .filter(Boolean);
  return names.length > 0 ? names : null;
}

/** `child` is `parent` or below it (both canonical absolute paths). */
function isSameOrBelow(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * How focus directories (absolute, from {@link resolveFocusForRoot}) apply to ONE index, whose root is
 * `indexRoot` (`cg.getProjectRoot()`):
 *  - `null`: no filtering. The focus is empty, or some focus directory is the index root or contains it, so
 *    every file of the index is in focus.
 *  - `[]`: nothing in this index is in focus (no focus directory lies inside it).
 *  - `[p, ...]`: index-relative posix prefixes (no trailing slash) of the focus directories inside the index.
 *
 * Both sides are compared in canonical form, so a symlinked spelling of the index root matches the canonical
 * focus directories.
 */
export function focusPrefixesFor(indexRoot: string, focus: readonly string[]): string[] | null {
  if (focus.length === 0) return null;
  const root = canonicalWithMissingTail(indexRoot);
  const prefixes: string[] = [];
  for (const dir of focus) {
    const canonical = canonicalWithMissingTail(dir);
    // The index root sits at or below this focus directory: all of the index is in focus.
    if (isSameOrBelow(canonical, root)) return null;
    if (!isSameOrBelow(root, canonical)) continue;
    const prefix = path.relative(root, canonical).split(path.sep).join('/');
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }
  return prefixes;
}

/**
 * How the session's repo-relative `focus` applies to the index rooted at `indexRoot`, in {@link focusPrefixesFor}'s
 * shape: the focus resolved against the root of the worktree that index sits in ({@link worktreeRootOf},
 * {@link resolveFocusForRoot}), then compared with the index root. The one answer a handler uses, so a sibling
 * worktree reads the focus against its own checkout and a nested index (`repo/sub/.codegraph`) still maps the
 * entry `sub/x` to the prefix `x`. `null` with no focus, without touching the filesystem.
 */
export function focusPrefixesForIndex(indexRoot: string, focus: readonly string[]): string[] | null {
  if (focus.length === 0) return null;
  return focusPrefixesFor(indexRoot, resolveFocusForRoot(worktreeRootOf(indexRoot), focus));
}

/**
 * Whether an index-relative file path is in focus: `prefixes` is null (no filtering), or the path is one of
 * the prefixes or below it. Compares whole path segments, so `srcx/a.ts` is not in `src`.
 */
export function inFocus(filePath: string, prefixes: readonly string[] | null): boolean {
  if (prefixes === null) return true;
  return prefixes.some((p) => filePath === p || filePath.startsWith(`${p}/`));
}

/**
 * The session focus a call carries ({@link SESSION_FOCUS_ARG}): the repo-relative entries, the strings of the
 * array, `[]` when the key is absent or malformed. A handler reads the focus only through this, and turns it
 * into directories per call with {@link focusPrefixesForIndex} or {@link resolveFocusForRoot}.
 */
export function sessionFocusFromArgs(args: Record<string, unknown>): string[] {
  const raw = args[SESSION_FOCUS_ARG];
  return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === 'string') : [];
}

/**
 * The session tool list a call carries ({@link SESSION_TOOLS_ARG}): the array of names, `null` for a session
 * told it has no allowlist, `undefined` when the key is absent or malformed (a session not told).
 */
export function sessionToolsFromArgs(args: Record<string, unknown>): SessionToolList {
  if (!(SESSION_TOOLS_ARG in args)) return undefined;
  const raw = args[SESSION_TOOLS_ARG];
  if (raw === null) return null;
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : undefined;
}

/**
 * `args` without the two internal session keys, as a copy; the same object when it carries neither. The one
 * way a wire-supplied value is removed, used by `dispatchToolCall` (every call) and by the extension-tool
 * dispatch, so an extension never sees an internal key.
 */
export function withoutSessionArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (!(SESSION_FOCUS_ARG in args) && !(SESSION_TOOLS_ARG in args)) return args;
  const copy = { ...args };
  delete copy[SESSION_FOCUS_ARG];
  delete copy[SESSION_TOOLS_ARG];
  return copy;
}
