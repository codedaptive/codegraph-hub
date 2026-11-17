import { releaseWriterLock, tryAcquireWriterLock } from '../../../mcp/writer-lock';
import { deadRebuildHolder } from './deadRebuildHolder';
import { discardSchemalessLeftover } from './discardSchemalessLeftover';

/**
 * Remove the schema-less database a killed cold build left in the worktree
 * `root` that is about to be seeded from a sibling, so the seed's copy can
 * take its place. True when it was removed.
 *
 * A schema-less database is not initialized (`isInitialized` is false), so the
 * abandoned-index path never sees it, and the seed refuses a target whose
 * `codegraph.db` exists. This answers false, reading and removing nothing,
 * while a rebuild holds `root` (`rebuildHeld`) or when `root` has no
 * `rebuild.pid` whose holder is dead (./deadRebuildHolder.ts): with no
 * `rebuild.pid`, as for a user's own `codegraph init`, nothing is removed.
 * Otherwise it takes over the dead holder's `rebuild.pid` (false if another
 * process takes it first) and, holding it, lets ./discardSchemalessLeftover.ts
 * decide and remove. It holds only `rebuild.pid`: the seed that follows takes
 * `codegraph.lock` itself.
 */
export function discardSeedTargetLeftover(root: string, rebuildHeld: (root: string) => boolean): boolean {
  if (rebuildHeld(root)) return false;
  const dead = deadRebuildHolder(root);
  if (!dead) return false;
  if (tryAcquireWriterLock(root, 'seed', 'rebuild.pid').kind === 'taken') return false;
  try {
    return discardSchemalessLeftover(root, dead);
  } finally {
    releaseWriterLock(root, 'rebuild.pid');
  }
}
