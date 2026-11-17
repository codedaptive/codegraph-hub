import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../../../directory';
import { isProcessAlive } from '../../../mcp/server-control';
import { readWriterLock } from '../../../mcp/writer-lock';
import { isDeadHolderRecord } from './isDeadHolderRecord';

/**
 * Whether `root` has a `rebuild.pid` whose holder is gone (./isDeadHolderRecord.ts):
 * true when the file exists and names no live process other than this one,
 * false with no file. `runColdBuild` (./cold-build.ts) reads this before it
 * takes the lock, since taking it over replaces the record that tells.
 */
export function deadRebuildHolder(root: string): boolean {
  if (!fs.existsSync(path.join(getCodeGraphDir(root), 'rebuild.pid'))) return false;
  return isDeadHolderRecord(readWriterLock(root, 'rebuild.pid'), process.pid, isProcessAlive);
}
