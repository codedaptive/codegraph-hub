/**
 * `codegraph upgrade` on the fork (runUpgrade in src/upgrade/index.ts): it installs the packed build attached to a
 * release of codedaptive/codegraph-hub with npm `--ignore-scripts`, and never installs `@colbymchenry/codegraph` from
 * the registry or fetches upstream's install.sh / install.ps1. `--ignore-scripts` matters: the sm.N package's
 * preuninstall removes every agent's global entries, and an npm upgrade uninstalls the old copy first.
 *
 * A bundle is told the manual npm command and exits 1; a pnpm, yarn or bun install is told that manager's own command
 * for the same asset and exits 1; npx runs nothing and names the npm command; a source checkout keeps
 * "git pull && npm run build".
 *
 * Every side effect goes through injected UpgradeDeps recorders: no test runs npm, touches the network or a real
 * install. The expected asset URL is spelled out here rather than taken from the hub-release module, so these cases
 * fail at an assertion against today's code and pin the URL independently of how the module builds it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runUpgrade, type InstallMethod, type UpgradeDeps } from '../../../src/upgrade';

const hubUrl = (v: string) =>
  `https://github.com/codedaptive/codegraph-hub/releases/download/v${v}/colbymchenry-codegraph-${v}.tgz`;
const URL_12 = hubUrl('1.6.2-sm.12');
const MANUAL_12 = `npm install -g --ignore-scripts ${URL_12}`;
/** Anything that would mean upstream's registry package or installer scripts. */
const UPSTREAM = [/@colbymchenry\/codegraph@/, /install\.sh/, /install\.ps1/, /raw\.githubusercontent/];

interface Calls {
  runs: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }>;
  out: string[];
  resolves: number;
}

function makeDeps(
  over: Partial<UpgradeDeps> & { method: InstallMethod },
): { deps: UpgradeDeps; calls: Calls } {
  const calls: Calls = { runs: [], out: [], resolves: 0 };
  const deps: UpgradeDeps = {
    currentVersion: over.currentVersion ?? '1.6.2-sm.11',
    method: over.method,
    resolveLatest: async () => {
      calls.resolves += 1;
      return over.resolveLatest ? over.resolveLatest() : 'v1.6.2-sm.12';
    },
    run: (cmd, args, env, cwd) => {
      calls.runs.push({ cmd, args, env, cwd });
      return 0;
    },
    capture: () => null,
    hasCommand: over.hasCommand ?? (() => false),
    wirePromptHook: async () => false,
    log: (m) => calls.out.push(m),
    warn: (m) => calls.out.push(m),
    error: (m) => calls.out.push(m),
    platform: over.platform ?? 'linux',
  };
  return { deps, calls };
}

/** Every string the upgrade printed or passed to a command. */
function everything(calls: Calls): string {
  return [...calls.out, ...calls.runs.map((r) => `${r.cmd} ${r.args.join(' ')}`)].join('\n');
}

function expectNoUpstream(calls: Calls): void {
  const all = everything(calls);
  for (const re of UPSTREAM) expect(all, `mentions ${re}`).not.toMatch(re);
}

describe('runUpgrade installs the hub release with npm --ignore-scripts', () => {
  it('npm global: one npm run installing the latest hub asset', async () => {
    const { deps, calls } = makeDeps({ method: { kind: 'npm', scope: 'global' } });
    expect(await runUpgrade({}, deps)).toBe(0);
    const npmRuns = calls.runs.filter((r) => r.cmd === 'npm');
    expect(npmRuns).toHaveLength(1);
    expect(npmRuns[0]!.args).toEqual(['install', '-g', '--ignore-scripts', URL_12]);
    expectNoUpstream(calls);
  });

  it('a pinned version, with or without v, installs that release and does not ask for the latest', async () => {
    for (const version of ['1.6.2-sm.12', 'v1.6.2-sm.12']) {
      const { deps, calls } = makeDeps({ method: { kind: 'npm', scope: 'global' } });
      expect(await runUpgrade({ version }, deps)).toBe(0);
      expect(calls.resolves, `resolveLatest called for pin ${version}`).toBe(0);
      expect(calls.runs.find((r) => r.cmd === 'npm')?.args).toEqual(['install', '-g', '--ignore-scripts', URL_12]);
      expectNoUpstream(calls);
    }
  });

  describe('npm local', () => {
    let root: string;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hub-upgrade-'));
    });
    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('installs the asset without -g, in the project that owns the install', async () => {
      const { deps, calls } = makeDeps({ method: { kind: 'npm', scope: 'local', root } });
      expect(await runUpgrade({}, deps)).toBe(0);
      const run = calls.runs.find((r) => r.cmd === 'npm');
      expect(run?.args).toEqual(['install', '--ignore-scripts', URL_12]);
      expect(run?.cwd).toBe(root);
      expectNoUpstream(calls);
    });
  });

  it('win32 npm global goes through cmd.exe with the same install', async () => {
    const { deps, calls } = makeDeps({ method: { kind: 'npm', scope: 'global' }, platform: 'win32' });
    expect(await runUpgrade({}, deps)).toBe(0);
    expect(calls.runs[0]).toMatchObject({ cmd: 'cmd.exe', args: ['/d', '/s', '/c', MANUAL_12] });
    expectNoUpstream(calls);
  });

  it('an older hub release is not an upgrade', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      resolveLatest: async () => 'v1.6.2-sm.9',
    });
    expect(await runUpgrade({}, deps)).toBe(0);
    expect(calls.runs).toHaveLength(0);
    expect(calls.out.join('\n')).toMatch(/Already up to date/);
  });
});

describe('runUpgrade names the hub command where npm cannot upgrade in place', () => {
  const bundles: Array<[string, InstallMethod, NodeJS.Platform]> = [
    ['unix', { kind: 'bundle', os: 'unix', bundleRoot: '/h/.codegraph/versions/v1.6.2-sm.11', installDir: '/h/.codegraph' }, 'linux'],
    ['windows', { kind: 'bundle', os: 'windows', bundleRoot: 'C:/x/codegraph/current', installDir: 'C:/x/codegraph' }, 'win32'],
  ];
  for (const [name, method, platform] of bundles) {
    it(`${name} bundle: exit 1, runs nothing, prints the manual hub command`, async () => {
      // curl, wget and powershell all "present": nothing may still be run.
      const { deps, calls } = makeDeps({ method, platform, hasCommand: () => true });
      expect(await runUpgrade({}, deps)).toBe(1);
      expect(calls.runs).toHaveLength(0);
      const out = calls.out.join('\n');
      expect(out).toContain(MANUAL_12);
      expect(out).toContain(URL_12);
      expectNoUpstream(calls);
    });
  }

  // An npm install over a pnpm, yarn or bun install can create a shadow copy, so each manager gets its own
  // command for the hub asset.
  const managers: Array<['pnpm' | 'yarn' | 'bun', boolean, string]> = [
    ['pnpm', true, `pnpm add -g --ignore-scripts ${URL_12}`],
    ['yarn', false, `yarn add --ignore-scripts ${URL_12}`],
    ['bun', true, `bun add -g --ignore-scripts ${URL_12}`],
  ];
  for (const [manager, global, command] of managers) {
    it(`${manager} ${global ? 'global' : 'local'}: exit 1, runs nothing, prints ${manager}'s own command for the hub asset`, async () => {
      const { deps, calls } = makeDeps({ method: { kind: 'package-manager', manager, global } });
      expect(await runUpgrade({}, deps)).toBe(1);
      expect(calls.runs).toHaveLength(0);
      const out = calls.out.join('\n');
      expect(out).toContain(command);
      expect(out).not.toContain('npm install -g');
      expectNoUpstream(calls);
    });
  }

  it('npx: exit 0, nothing to upgrade, names the hub command and not npx of upstream', async () => {
    const { deps, calls } = makeDeps({ method: { kind: 'npx' } });
    expect(await runUpgrade({}, deps)).toBe(0);
    expect(calls.runs).toHaveLength(0);
    const out = calls.out.join('\n');
    expect(out).toMatch(/nothing to upgrade/i);
    expect(out).toContain(MANUAL_12);
    expect(out).not.toContain('npx @colbymchenry/codegraph');
    expectNoUpstream(calls);
  });

  it('source checkout: exit 0, runs nothing, git pull && npm run build', async () => {
    const { deps, calls } = makeDeps({ method: { kind: 'source', root: '/dev/codegraph' } });
    expect(await runUpgrade({}, deps)).toBe(0);
    expect(calls.runs).toHaveLength(0);
    expect(calls.out.join('\n')).toMatch(/git pull && npm run build/);
  });

  it("unknown install: exit 1, points at the hub's releases, not upstream's install page", async () => {
    const { deps, calls } = makeDeps({ method: { kind: 'unknown', reason: 'test layout' } });
    expect(await runUpgrade({}, deps)).toBe(1);
    expect(calls.runs).toHaveLength(0);
    const out = calls.out.join('\n');
    expect(out).toContain('codedaptive/codegraph-hub');
    expect(out).not.toContain('colbymchenry/codegraph#install');
  });
});
