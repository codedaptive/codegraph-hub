/**
 * The bytes free to this process on the file system holding `dir`, for the VACUUM disk rule (./vacuum-verdict.ts).
 * Null when the file system cannot be asked, which the rule counts as too little.
 */
import { statfsSync } from 'node:fs';

export function freeDiskBytes(dir: string): number | null {
  try {
    const stats = statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}
