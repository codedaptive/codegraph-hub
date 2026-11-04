/**
 * How the queries zone's MCP tools read the calling session's focus
 * (`serve --mcp --focus <dir>`, `ExtensionToolContext.focus`, which host resolves
 * per call against the worktree the call is answered from): `grep` searches
 * inside it unless the call passes `scope: "repo"`, and `blast` covers the whole
 * repository and lists the dependents outside it under `## Outside focus (N)`.
 * `orphans` ignores it.
 *
 * The rule that decides what is in focus is host's (`focusPrefixesFor`,
 * `inFocus` in src/extensions/host/server/session-scope.ts); this module only
 * calls it, and words the answers the way the built-in search, explore, callers
 * and impact word theirs (src/mcp/tools.ts), so an agent reads both the same.
 * Host's wording helpers there are private to tools.ts, so the two helpers below
 * (`nothingInFocusText`, `focusDirsText`) must be changed together with them:
 * `nothingInFocusText` is a copy, `focusDirsText` is adapted to absolute focus entries.
 *
 * The tools import this module lazily, inside their handlers, so the extension's
 * own load stays free of it and of what it imports.
 */
import * as path from 'path';
import { focusPrefixesFor } from '../../host/server/session-scope';

/** The heading the out-of-focus part of an impact answer goes under, as host's callers and impact print it. */
export const OUTSIDE_FOCUS_HEADING = 'Outside focus';

/** `## Outside focus (N)`: the heading line, byte-equal to host's. */
export function outsideFocusHeading(count: number): string {
  return `## ${OUTSIDE_FOCUS_HEADING} (${count})`;
}

/**
 * How the session focus applies to the index rooted at `indexRoot`, through
 * host's `focusPrefixesFor`: `null` filters nothing (no focus, or the focus
 * contains the whole index), `[]` means no file of this index is in focus,
 * otherwise the index-relative posix prefixes a path must sit under (test a
 * path with host's `inFocus`). `wholeRepo` is a finding tool's `scope: "repo"`:
 * it lifts the filter for that call, as host's `focusPrefixesOfCall` does for
 * search and explore. `focus` is `ctx.focus`: host's focus for this call, its
 * absolute canonical directories resolved against the root of the worktree the
 * call is answered from. It is read only through this.
 */
export function focusPrefixesOfTool(
  indexRoot: string,
  focus: readonly string[] | undefined,
  wholeRepo = false,
): string[] | null {
  if (wholeRepo) return null;
  return focusPrefixesFor(indexRoot, focus ?? []);
}

/**
 * The focus directories as a sentence names them: the index-relative
 * `prefixes`, or, when no focus directory lies inside this index (`[]`), the
 * session's focus directories relative to the index root. Host's
 * `focusDirsText` (src/mcp/tools.ts) reads the session's entries from the call's
 * args, already relative to the repository root; this one takes the absolute
 * `focus` entries and makes them relative to the index root.
 */
export function focusDirsText(indexRoot: string, focus: readonly string[] | undefined, prefixes: readonly string[]): string {
  const dirs = prefixes.length > 0
    ? [...prefixes]
    : (focus ?? []).map((d) => path.relative(indexRoot, d).split('\\').join('/') || '.');
  return dirs.join(', ');
}

/**
 * The answer for a finding call whose focus held back every hit while the
 * whole repository has some: success-shaped (never an error), naming the focus
 * and how to widen the call. Host's `nothingInFocusText` (src/mcp/tools.ts),
 * copied word for word.
 */
export function nothingInFocusText(dirs: string): string {
  return `No results inside this session's focus (${dirs}). Pass scope: "repo" to search the whole repository.`;
}
