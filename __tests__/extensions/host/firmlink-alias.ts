/**
 * Test seam: one physical directory under two path spellings that `realpath`
 * keeps apart, the way macOS keeps `/Users/...` and `/System/Volumes/Data/Users/...`
 * (a firmlink) apart. A firmlink cannot be made in a test, and a symlink alone
 * does not do it (realpath resolves a symlink to its target). So the alias is a
 * symlink, whose `dev:ino` is the target's, and `fs.realpathSync.native` is
 * spied to return a path under the alias unchanged, as it does for a firmlink:
 * `getStateDir()` then spells the directory two ways while the directory's
 * identity is one.
 *
 * The caller restores the spy with `vi.restoreAllMocks()` (or the returned
 * `restore`).
 */
import { vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

export function installFirmlinkAlias(real: string, alias: string): { restore: () => void } {
  fs.symlinkSync(real, alias, 'dir');
  const realpathNative = fs.realpathSync.native;
  const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike, options?: unknown) => {
    const s = String(p);
    if (s === alias || s.startsWith(alias + path.sep)) return s; // a firmlink keeps its own spelling
    return (realpathNative as (p: fs.PathLike, o?: unknown) => string)(p, options);
  }) as typeof fs.realpathSync.native);
  return { restore: () => spy.mockRestore() };
}
