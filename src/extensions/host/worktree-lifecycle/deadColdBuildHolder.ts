import { isProcessAlive } from '../../../mcp/server-control';
import { readWriterLock } from '../../../mcp/writer-lock';
import { isDeadHolderRecord } from './isDeadHolderRecord';

/**
 * Whether `root`'s `rebuild.pid` was left by a cold build whose process is gone: the record reads, its mode is
 * `cold-build`, and its holder is dead (./isDeadHolderRecord.ts). False with no file, and for a record that does
 * not read (a foreign or reused-pid one), since its mode cannot be told. A `codegraph index` lease's record has
 * mode `rebuild`, and a user's `codegraph init` takes no `rebuild.pid`. `runColdBuild` (./cold-build.ts) reads
 * this before it takes the lock, since taking it over replaces the record that tells.
 */
export function deadColdBuildHolder(root: string): boolean {
  const record = readWriterLock(root, 'rebuild.pid');
  return record?.mode === 'cold-build' && isDeadHolderRecord(record, process.pid, isProcessAlive);
}
