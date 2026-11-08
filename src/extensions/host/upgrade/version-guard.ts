/**
 * Upgrade targets reach a release URL and, on Windows, a cmd.exe command line.
 * Compare the whole string with the reconstructed version: parseSemver trims
 * input and its regex is not end-anchored, so a parse can ignore extra input.
 */
import { parseSemver } from '../../../upgrade';

export function isWholeVersion(v: string): boolean {
  const s = parseSemver(v);
  if (!s) return false;
  const rebuilt = `v${s.major}.${s.minor}.${s.patch}${s.pre ? `-${s.pre}` : ''}`;
  return rebuilt === (v.startsWith('v') ? v : `v${v}`);
}

export function upgradeTargetRefusal(v: string): string | null {
  return isWholeVersion(v)
    ? null
    : `Refusing to upgrade: ${JSON.stringify(v)} is not a version (expected one like 1.6.2 or v1.6.2-sm.14).`;
}
