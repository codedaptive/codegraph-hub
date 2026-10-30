/**
 * The git-free pre-check the MCP tool handler runs on every call that names a
 * project, before it loads ./seed.ts: whether seeding could apply to
 * `projectPath` at all. A few stats, and no git. Light on purpose (Node
 * built-ins, src/directory and ./git only): src/mcp/tools.ts imports it at its
 * top level, while ./seed.ts, with its writer-lock and SQLite dependencies, is
 * loaded only once this says yes.
 */
import * as fs from 'fs';
import * as path from 'path';
import { findNearestCodeGraphRoot, getCodeGraphDir } from '../../../directory';
import { gitWorktreeRootMayBeBelow } from './git';

/**
 * True when `projectPath` may need a seed: a `.git` entry sits between it and
 * the index it resolves to (or it resolves to none), so it may be in a git
 * worktree with no index of its own; or a `rebuild.pid` sits beside that
 * index, which may mark a killed build's partial index for ./seed.ts to
 * discard and replace. False means the call is against a finished index of
 * the tree's own, which needs nothing from the seeder.
 */
export function worktreeSeedMayApply(projectPath: string): boolean {
  const nearest = findNearestCodeGraphRoot(projectPath);
  if (nearest !== null && fs.existsSync(path.join(getCodeGraphDir(nearest), 'rebuild.pid'))) return true;
  return gitWorktreeRootMayBeBelow(projectPath, nearest);
}
