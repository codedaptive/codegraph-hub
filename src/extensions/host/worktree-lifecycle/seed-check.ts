/**
 * The pre-check the MCP tool handler runs on every call that names a
 * project, before it loads ./seed.ts: whether seeding or a cold build could
 * apply to `projectPath` at all. A few stats, and git only when a git repository
 * sits between the path and an index above it. Light on purpose (Node
 * built-ins, src/directory, the index-selection helpers (`selectOwnIndexRoot`,
 * which spawns git only for such a path, and src/sync/worktree) and ./git only):
 * src/mcp/tools.ts imports it at its top level, while ./seed.ts, with its
 * writer-lock and SQLite dependencies, is loaded only once this says yes.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../../../directory';
import { realLocation, selectOwnIndexRoot } from '../server/index-root';
import { gitWorktreeRootMayBeBelow } from './git';

/**
 * True when `projectPath` may need a seed or a cold build: a `.git` entry sits
 * between it and the index it resolves to (`selectOwnIndexRoot`: a sub-project
 * index nested in a worktree does not count, and an index above a git repository
 * nested around the path is another repository's, so it resolves to none) or it
 * resolves to none, so it may
 * be in a git worktree with no index of its own, or (no `.git` entry at all, no
 * index at all) be a plain directory the builder cold-builds at the session's
 * launch directory; or a `rebuild.pid` sits beside that index, which may mark
 * a killed build's partial index for ./seed.ts to discard and replace. False
 * means the call is against a finished index of the tree's own, which needs
 * nothing from the seeder.
 */
export function worktreeSeedMayApply(projectPath: string): boolean {
  const nearest = selectOwnIndexRoot(projectPath);
  if (nearest !== null && fs.existsSync(path.join(getCodeGraphDir(nearest), 'rebuild.pid'))) return true;
  // No index of the path's own (selectOwnIndexRoot is null): a git worktree to seed or build, or a plain
  // directory to build. Either
  // way the builder decides (seed.ts ensureWorktreeIndex); a path that cannot be built answers there.
  if (nearest === null) return true;
  // `nearest` is spelled by its real location, so the walk up to it starts from the path's real location too:
  // walked lexically, a symlinked ancestor of an indexed checkout would meet the checkout's `.git` under the
  // alias's own spelling before reaching `nearest`, and the call would ask the builder again for a held index.
  return gitWorktreeRootMayBeBelow(realLocation(projectPath), nearest);
}
