/**
 * The CLI's project check for the zone's diff-based commands (`blast`,
 * `orphans`): whether the path a user gave sits in a nested git repository the
 * nearest index does not cover.
 *
 * Its top level imports only types: the git-toplevel helper and the engine
 * (`CodeGraph`, which pulls in the database layer) are loaded with
 * `await import()` on the call, so importing this module adds nothing to
 * startup.
 */
import type { CodeGraph } from '../../../index';

/**
 * Whether `start` lies in a different git repository nested below `indexRoot`
 * whose files that index does not hold (typically a gitignored checkout such
 * as `vendor/child`). The CLI's form of the MCP rule in
 * `ToolHandler.uncoveredNestedRepo` (#2110), built from the same two checks:
 * `nestedRepositoryBelow` compares the git toplevels (and lets a linked
 * worktree of the index's own repository through), then the index is asked
 * whether it holds any file under that repository. A submodule or embedded
 * clone the parent index does cover is answered from it, as over MCP.
 *
 * An index that cannot be opened is no evidence the repository is excluded,
 * so it answers false and the command reports on the index as it stands.
 */
export async function isUncoveredNestedRepo(start: string, indexRoot: string): Promise<boolean> {
  const { nestedRepositoryBelow } = await import('../../../sync/worktree');
  const nested = nestedRepositoryBelow(start, indexRoot);
  if (!nested) return false;
  const engine = await import('../../../index');
  let cg: CodeGraph | null = null;
  try {
    cg = engine.CodeGraph.openSync(indexRoot, { readOnly: true });
    return !cg.hasFilesUnder(nested.relPath);
  } catch {
    return false;
  } finally {
    cg?.close();
  }
}
