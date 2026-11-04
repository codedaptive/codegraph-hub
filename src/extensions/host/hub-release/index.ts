/** Release identity and install commands for the hub's packed builds. */
export const HUB_REPO = 'codedaptive/codegraph-hub';
export const HUB_UPDATE_CHECK_CACHE_FILE = 'update-check-hub.json';

export function hubReleaseTag(version: string): string {
  return `v${version.trim().replace(/^v/, '')}`;
}

/** The asset name matches the tarball produced by fleet/pack.sh. */
export function hubReleaseAssetUrl(version: string): string {
  const tag = hubReleaseTag(version);
  return `https://github.com/${HUB_REPO}/releases/download/${tag}/colbymchenry-codegraph-${tag.slice(1)}.tgz`;
}

/** Semver §11: numeric identifiers precede text; a shared prefix sorts first. */
export function comparePrerelease(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]!;
    const y = right[i]!;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      // BigInt keeps precedence exact even beyond Number's safe integer range.
      const nx = BigInt(x);
      const ny = BigInt(y);
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else {
      return x < y ? -1 : 1;
    }
  }
  return left.length - right.length;
}

export function hubNpmInstallArgs(scope: 'global' | 'local', version: string): string[] {
  // Ignore lifecycle scripts: the sm.N package's preuninstall removes every agent's global CodeGraph entries.
  return ['install', ...(scope === 'global' ? ['-g'] : []), '--ignore-scripts', hubReleaseAssetUrl(version)];
}

/** Keep the install's manager to avoid a shadow copy; ignore scripts because the sm.N preuninstall removes every agent's global CodeGraph entries. */
export function hubPackageManagerCommand(manager: 'pnpm' | 'yarn' | 'bun', global: boolean, version: string): string {
  const command = manager === 'yarn' && global
    ? 'yarn global add'
    : `${manager} add${global ? ' -g' : ''}`;
  return `${command} --ignore-scripts ${hubReleaseAssetUrl(version)}`;
}

export function hubManualInstallCommand(version: string): string {
  return `npm ${hubNpmInstallArgs('global', version).join(' ')}`;
}
