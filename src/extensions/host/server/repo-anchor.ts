/**
 * The repo anchor and the one call guard of the machine server.
 *
 * One server answers for every client on the machine, so a session cannot
 * rely on a process-wide "current project". Two rules replace it:
 *
 *  - Required `projectPath`: a tool call names the root path of the code it
 *    wants answered, and a call without one gets {@link MISSING_PROJECT_PATH_TEXT}
 *    and nothing else. There is no fallback to a session default, a hint or the
 *    server's own cwd.
 *  - The repo anchor: the directory a session was launched in fixes the
 *    repository it answers for (that repository and every worktree sharing its
 *    git common dir). A call outside it gets success-shaped guidance that names
 *    the anchor, never `isError`: an error teaches the agent to abandon
 *    codegraph for the rest of the session, guidance lets it correct the path.
 *
 * {@link sessionCallGuard} is the single implementation of both, used by
 * `MCPSession.handleToolsCall` and by the proxy's in-process fallback, so a
 * session served by the machine server and one served in-process agree.
 *
 * The git lookups are async, so no spawn blocks the main thread; the realpath
 * and stat calls are synchronous and cheap.
 */
import * as path from 'path';
import type { IndexRootAdmission, ToolResult } from '../../../mcp/tools';
import {
  canonicalGitPath,
  gitCommonDirAsync,
  gitWorktreeRootAsync,
  nearestExistingDirectory,
} from '../worktree-lifecycle/git';

/**
 * The exact required-projectPath answer. Agents and gates compare it byte for
 * byte: do not reword. Also written out in server-instructions.ts and the
 * projectPath schema in tools.ts; change all three together.
 */
export const MISSING_PROJECT_PATH_TEXT = 'missing argument: root path to the code you wish to query';

/** What a session was launched in, fixed once when the session is created. */
export interface RepoAnchor {
  /** realpath of the launch directory; relative `projectPath`s resolve against it. */
  launchDir: string;
  /** git worktree root of `launchDir` (realpath), or `launchDir` when it is not in git. */
  root: string;
  /** Canonical git common dir (`gitCommonDirAsync`, shared by every worktree of the repo); null outside git. */
  commonDir: string | null;
}

/**
 * Resolve the anchor of a launch directory. `launchDir` need not exist (a
 * client can report a directory that has since gone): the nearest existing
 * ancestor is asked about git, and a launch directory with no repository is
 * its own root.
 */
export async function resolveRepoAnchor(launchDir: string): Promise<RepoAnchor> {
  const resolvedLaunchDir = canonicalGitPath(launchDir);
  const [root, commonDir] = await Promise.all([
    gitWorktreeRootAsync(resolvedLaunchDir),
    gitCommonDirAsync(resolvedLaunchDir),
  ]);
  return {
    launchDir: resolvedLaunchDir,
    root: commonDir !== null && root !== null ? root : resolvedLaunchDir,
    commonDir,
  };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** A path the memo remembers for this long. A directory can later become a repository (`git init`), so the answer expires. */
const INSIDE_MEMO_TTL_MS = 60_000;
/** Memo size cap. A session touches a handful of paths; the bound only stops an agent that probes thousands of distinct ones. */
const INSIDE_MEMO_MAX = 512;

interface MemoEntry {
  inside: boolean;
  expires: number;
}

/**
 * Inside/outside answers by anchor and resolved path. Module-level, so the
 * sessions of one server share it; the key carries the anchor's identity so two
 * anchors never read each other's answers. A Map keeps insertion order, which
 * gives the oldest-first eviction for free.
 */
const insideMemo = new Map<string, MemoEntry>();

function memoKey(anchor: RepoAnchor, resolved: string): string {
  return `${anchor.commonDir ?? `root:${anchor.root}`}\0${resolved}`;
}

function memoRemember(key: string, inside: boolean): void {
  insideMemo.delete(key);
  insideMemo.set(key, { inside, expires: Date.now() + INSIDE_MEMO_TTL_MS });
  while (insideMemo.size > INSIDE_MEMO_MAX) {
    const oldest = insideMemo.keys().next().value;
    if (oldest === undefined) break;
    insideMemo.delete(oldest);
  }
}

/** `child` is `parent` or below it (both canonical absolute paths). */
function isSameOrBelow(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * The canonical spelling of `p` when it may not exist: the nearest existing
 * ancestor's realpath with the missing tail appended, so a symlinked parent of
 * a not-yet-created path still compares correctly against the anchor root.
 */
function canonicalWithMissingTail(p: string): string {
  const existing = nearestExistingDirectory(p);
  if (!existing) return path.resolve(p);
  const tail = path.relative(existing, path.resolve(p));
  const base = canonicalGitPath(existing);
  return tail ? path.join(base, tail) : base;
}

async function isInsideAnchor(anchor: RepoAnchor, resolved: string): Promise<boolean> {
  const key = memoKey(anchor, resolved);
  const hit = insideMemo.get(key);
  if (hit && hit.expires > Date.now()) return hit.inside;

  let inside: boolean;
  if (anchor.commonDir !== null) {
    // Same repository <=> same git common dir: every linked worktree shares the
    // main checkout's, a nested repository or submodule has its own, so it is
    // outside even though it sits under the anchor's directory.
    inside = (await gitCommonDirAsync(resolved)) === anchor.commonDir;
  } else {
    // A launch directory outside git has no repository to share, so the anchor
    // is the directory itself and its subtree.
    inside = isSameOrBelow(anchor.root, canonicalWithMissingTail(resolved));
  }
  memoRemember(key, inside);
  return inside;
}

/**
 * The required-projectPath and repo-anchor check for one tool call (see the file
 * comment).
 *
 *  - `args.projectPath` missing, not a string, or blank: the exact required-projectPath text.
 *  - `anchor` null (the client reported no launch directory): guidance to
 *    restart the session; without an anchor nothing can be proven inside.
 *  - `projectPath` outside the anchor: guidance naming `anchor.root`.
 *  - inside: the absolute resolved path, which the caller substitutes into the
 *    call's arguments so every layer below sees the same spelling.
 *
 * Neither answer sets `isError`. A relative `projectPath` resolves against the
 * launch directory, never the server process's cwd (the server's cwd is its
 * state dir).
 */
export async function sessionCallGuard(
  args: Record<string, unknown>,
  anchor: RepoAnchor | null,
): Promise<{ answer: ToolResult } | { projectPath: string }> {
  const given = args.projectPath;
  if (typeof given !== 'string' || given.trim() === '') {
    return { answer: textResult(MISSING_PROJECT_PATH_TEXT) };
  }

  if (anchor === null) {
    return {
      answer: textResult(
        'This codegraph session did not report the directory it was launched in, so it cannot tell which ' +
          'repository it answers for. Restart the session from inside the repository you want to query.',
      ),
    };
  }

  const resolved = path.resolve(anchor.launchDir, given);
  if (!(await isInsideAnchor(anchor, resolved))) {
    return {
      answer: textResult(
        `This codegraph session answers only for the repository it was launched in, ${anchor.root}, and its ` +
          `git worktrees, or, launched outside git, only the launch directory and what is below it. "${given}" is outside it. Pass a projectPath inside ${anchor.root} (or one of ` +
          'its worktrees), and use your built-in tools (Read/Grep/Glob) for code elsewhere.',
      ),
    };
  }
  return { projectPath: resolved };
}

/**
 * The session's admission check of the index a call is answered from, handed to
 * `ToolHandler.execute` (`options.admitIndexRoot`). A `projectPath` inside the
 * anchor can still resolve to an index OUTSIDE it: index discovery walks up past
 * the repository (an `outer/.codegraph` that indexes `outer/repo`), and answering
 * from that graph would leak code the session may not read. The handler asks this
 * about the root its own resolver selected, before opening it, and it applies the
 * same inside rule as {@link sessionCallGuard} (one `isInsideAnchor`, so the path
 * and its index can never be judged by two rules). Outside: success-shaped
 * guidance naming the anchor and the outside index, never `isError`.
 */
export function indexRootAdmission(anchor: RepoAnchor): IndexRootAdmission {
  return async (indexRoot) => {
    if (await isInsideAnchor(anchor, indexRoot)) return null;
    return (
      `This codegraph session answers only for the repository it was launched in, ${anchor.root}, and its ` +
      `git worktrees, or, launched outside git, only the launch directory and what is below it. The index that covers the path you gave is at ${indexRoot}, outside that repository, so ` +
      'codegraph does not answer from it. Use your built-in tools (Read/Grep/Glob) for this code.'
    );
  };
}
