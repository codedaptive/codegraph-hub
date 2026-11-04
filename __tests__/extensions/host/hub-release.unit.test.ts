/**
 * The hub's release helpers (src/extensions/host/hub-release/) and the `-sm.N` version order they feed into
 * `compareVersions` / `isUpdateAvailable` in src/upgrade/index.ts.
 *
 * The fork ships as `1.6.2-sm.N` prereleases of codedaptive/codegraph-hub. Before the hub-release module, two
 * prereleases compared as plain text, so `1.6.2-sm.9` sorted after `1.6.2-sm.11` and an sm.11 install was offered sm.9
 * as an update. The order here is semver's (§11): dot-separated identifiers, all-digit ones compared as numbers, numeric
 * below alphanumeric, ASCII otherwise, and a longer set above a shorter one it extends.
 *
 * The first describe imports only src/upgrade, so it fails at an assertion while the order is text. The hub-release
 * module is loaded inside each test of the second describe, so those tests fail at the import until the module exists,
 * without taking the first describe down with them.
 */
import { describe, expect, it } from 'vitest';
import { compareVersions, isUpdateAvailable } from '../../../src/upgrade';

const HUB_URL_12 =
  'https://github.com/codedaptive/codegraph-hub/releases/download/v1.6.2-sm.12/colbymchenry-codegraph-1.6.2-sm.12.tgz';

/** semver.org §11's own example, lowest first. */
const SEMVER_ORDER = [
  '1.0.0-alpha',
  '1.0.0-alpha.1',
  '1.0.0-alpha.beta',
  '1.0.0-beta',
  '1.0.0-beta.2',
  '1.0.0-beta.11',
  '1.0.0-rc.1',
  '1.0.0',
];

const loadHub = () => import('../../../src/extensions/host/hub-release');

describe('compareVersions orders -sm.N prereleases by number', () => {
  it('1.6.2-sm.9 < 1.6.2-sm.11 < 1.6.2-sm.12', () => {
    expect(Math.sign(compareVersions('1.6.2-sm.9', '1.6.2-sm.11'))).toBe(-1);
    expect(Math.sign(compareVersions('1.6.2-sm.11', '1.6.2-sm.9'))).toBe(1);
    expect(Math.sign(compareVersions('1.6.2-sm.11', '1.6.2-sm.12'))).toBe(-1);
    expect(Math.sign(compareVersions('1.6.2-sm.9', '1.6.2-sm.12'))).toBe(-1);
  });

  it('equal versions are equal, with or without the leading v', () => {
    expect(compareVersions('1.6.2-sm.11', '1.6.2-sm.11')).toBe(0);
    expect(compareVersions('v1.6.2-sm.11', '1.6.2-sm.11')).toBe(0);
  });

  it("follows semver's precedence example", () => {
    for (let i = 0; i + 1 < SEMVER_ORDER.length; i++) {
      const lo = SEMVER_ORDER[i]!;
      const hi = SEMVER_ORDER[i + 1]!;
      expect(Math.sign(compareVersions(lo, hi)), `${lo} < ${hi}`).toBe(-1);
      expect(Math.sign(compareVersions(hi, lo)), `${hi} > ${lo}`).toBe(1);
    }
  });

  it('an sm.11 install is offered sm.12 and not sm.9', () => {
    expect(isUpdateAvailable('1.6.2-sm.9', 'v1.6.2-sm.11')).toBe(true);
    expect(isUpdateAvailable('1.6.2-sm.11', 'v1.6.2-sm.9')).toBe(false);
  });
});

describe('hub-release module', () => {
  it('names the hub repository and its own update-check cache file', async () => {
    const hub = await loadHub();
    expect(hub.HUB_REPO).toBe('codedaptive/codegraph-hub');
    expect(hub.HUB_UPDATE_CHECK_CACHE_FILE).toBe('update-check-hub.json');
  });

  it('comparePrerelease orders -sm.N by number and equal sets as equal', async () => {
    const { comparePrerelease } = await loadHub();
    expect(Math.sign(comparePrerelease('sm.9', 'sm.11'))).toBe(-1);
    expect(Math.sign(comparePrerelease('sm.11', 'sm.12'))).toBe(-1);
    expect(Math.sign(comparePrerelease('sm.12', 'sm.9'))).toBe(1);
    expect(comparePrerelease('sm.11', 'sm.11')).toBe(0);
  });

  it("comparePrerelease follows semver's precedence example", async () => {
    const { comparePrerelease } = await loadHub();
    // The release itself has no prerelease part; compare the prerelease identifiers only.
    const pres = SEMVER_ORDER.slice(0, -1).map((v) => v.slice('1.0.0-'.length));
    for (let i = 0; i + 1 < pres.length; i++) {
      expect(Math.sign(comparePrerelease(pres[i]!, pres[i + 1]!)), `${pres[i]} < ${pres[i + 1]}`).toBe(-1);
      expect(Math.sign(comparePrerelease(pres[i + 1]!, pres[i]!)), `${pres[i + 1]} > ${pres[i]}`).toBe(1);
    }
    // numeric identifiers sort below alphanumeric ones
    expect(Math.sign(comparePrerelease('1', 'alpha'))).toBe(-1);
  });

  it('hubReleaseTag gives the v-prefixed tag for either spelling', async () => {
    const { hubReleaseTag } = await loadHub();
    expect(hubReleaseTag('1.6.2-sm.12')).toBe('v1.6.2-sm.12');
    expect(hubReleaseTag('v1.6.2-sm.12')).toBe('v1.6.2-sm.12');
    expect(hubReleaseTag('  v1.6.2-sm.12 ')).toBe('v1.6.2-sm.12');
  });

  it("hubReleaseAssetUrl points at the release's packed build for either spelling", async () => {
    const { hubReleaseAssetUrl } = await loadHub();
    expect(hubReleaseAssetUrl('1.6.2-sm.12')).toBe(HUB_URL_12);
    expect(hubReleaseAssetUrl('v1.6.2-sm.12')).toBe(HUB_URL_12);
  });

  it('hubNpmInstallArgs installs the asset with --ignore-scripts, -g only for a global install', async () => {
    const { hubNpmInstallArgs } = await loadHub();
    expect(hubNpmInstallArgs('global', 'v1.6.2-sm.12')).toEqual(['install', '-g', '--ignore-scripts', HUB_URL_12]);
    expect(hubNpmInstallArgs('local', '1.6.2-sm.12')).toEqual(['install', '--ignore-scripts', HUB_URL_12]);
  });

  it("hubPackageManagerCommand is each manager's own add command for the asset", async () => {
    const { hubPackageManagerCommand } = await loadHub();
    expect(hubPackageManagerCommand('pnpm', true, '1.6.2-sm.12')).toBe(`pnpm add -g --ignore-scripts ${HUB_URL_12}`);
    expect(hubPackageManagerCommand('pnpm', false, 'v1.6.2-sm.12')).toBe(`pnpm add --ignore-scripts ${HUB_URL_12}`);
    expect(hubPackageManagerCommand('yarn', true, '1.6.2-sm.12')).toBe(`yarn global add --ignore-scripts ${HUB_URL_12}`);
    expect(hubPackageManagerCommand('yarn', false, '1.6.2-sm.12')).toBe(`yarn add --ignore-scripts ${HUB_URL_12}`);
    expect(hubPackageManagerCommand('bun', true, '1.6.2-sm.12')).toBe(`bun add -g --ignore-scripts ${HUB_URL_12}`);
    expect(hubPackageManagerCommand('bun', false, '1.6.2-sm.12')).toBe(`bun add --ignore-scripts ${HUB_URL_12}`);
  });

  it('hubManualInstallCommand is the global npm command for the asset', async () => {
    const { hubManualInstallCommand } = await loadHub();
    expect(hubManualInstallCommand('1.6.2-sm.12')).toBe(`npm install -g --ignore-scripts ${HUB_URL_12}`);
  });
});
