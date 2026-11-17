/**
 * The folder outside git a path belongs to when a person opted that folder in to indexing with
 * `codegraph init <dir> --no-git` (R-50, SPEC §3 "Only a git worktree root is indexed, unless a folder is
 * opted in"). The opt-in is the NO_GIT bit of the folder's project registry record; nothing else opts a
 * folder in: a pinned or seeded record, or a `.codegraph/` with no record, does not.
 */
import * as path from 'path';
import { getRegisteredProject, PROJECT_FLAG_NO_GIT } from '../worktree-lifecycle/project-registry';

/**
 * The nearest directory at or above `realPath` (already a real location: see index-root.ts `realLocation`)
 * whose registry record carries {@link PROJECT_FLAG_NO_GIT}, spelled as its record spells it; null when none
 * has. One record read per level, no git.
 */
export function optedInRootByStat(realPath: string): string | null {
  let dir = realPath;
  for (;;) {
    const rec = getRegisteredProject(dir);
    if (rec && (rec.flags & PROJECT_FLAG_NO_GIT) !== 0) return rec.root;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
