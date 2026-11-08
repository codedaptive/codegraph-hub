import { describe, expect, it } from 'vitest';
import { runUpgrade, upgradeWindowsBundle, type InstallMethod, type UpgradeDeps } from '../../../src/upgrade';
import { hubManualInstallCommand } from '../../../src/extensions/host/hub-release';

const npmGlobal: InstallMethod = { kind: 'npm', scope: 'global' };
const windowsBundle: Extract<InstallMethod, { kind: 'bundle' }> = {
  kind: 'bundle', os: 'windows', bundleRoot: 'C:\\codegraph', installDir: 'C:\\codegraph',
};

function makeDeps(method: InstallMethod, platform: NodeJS.Platform, latest = 'v1.6.2-sm.12') {
  const calls = {
    runs: [] as Array<{ cmd: string; args: string[] }>,
    captures: [] as Array<{ cmd: string; args: string[] }>,
    logs: [] as string[],
    errors: [] as string[],
    resolves: 0,
  };
  const deps: UpgradeDeps = {
    currentVersion: '1.6.2-sm.11', method, platform,
    resolveLatest: async () => { calls.resolves++; return latest; },
    run: (cmd, args) => { calls.runs.push({ cmd, args }); return 0; },
    capture: (cmd, args) => { calls.captures.push({ cmd, args }); return null; },
    hasCommand: () => false,
    wirePromptHook: async () => false,
    log: (message) => calls.logs.push(message),
    warn: (message) => calls.logs.push(message),
    error: (message) => calls.errors.push(message),
  };
  return { deps, calls };
}

function expectRefusal(calls: ReturnType<typeof makeDeps>['calls'], target: string) {
  expect(calls.runs).toEqual([]);
  expect(calls.captures).toEqual([]);
  expect(calls.errors.some((line) => line.includes(JSON.stringify(target)) && line.includes('not a version'))).toBe(true);
  for (const line of calls.logs) {
    expect(line).not.toContain(target);
  }
}

describe('upgrade refuses unsafe target versions', () => {
  const pins = ['1.2.3&calc', '1.2.3"', 'v1.2.3 | x', '01.2.3', '1.2.3+build'];
  const cases = pins.flatMap((pin) => (['win32', 'linux'] as const).map((platform) => ({ pin, platform })));
  it.each(cases)('refuses pinned $pin on $platform before any command or unsafe output', async ({ pin, platform }) => {
    const { deps, calls } = makeDeps(npmGlobal, platform);
    const result = await runUpgrade({ version: pin }, deps);
    expect(result).toBe(1);
    expect(calls.resolves).toBe(0);
    const normalized = pin.startsWith('v') ? pin : `v${pin}`;
    expectRefusal(calls, normalized);
    for (const line of calls.logs) expect(line).not.toContain(pin);
  });

  it('refuses an unsafe resolved latest version before any command or unsafe output', async () => {
    const target = 'v1.2.3&calc';
    const { deps, calls } = makeDeps(npmGlobal, 'win32', target);
    const result = await runUpgrade({}, deps);
    expect(result).toBe(1);
    expect(calls.resolves).toBe(1);
    expectRefusal(calls, target);
  });

  it('refuses an unsafe pin in check mode', async () => {
    const { deps, calls } = makeDeps(npmGlobal, 'win32');
    const result = await runUpgrade({ version: '1.9.3&calc', check: true }, deps);
    expect(result).toBe(1);
    expectRefusal(calls, 'v1.9.3&calc');
  });

  const methods: Array<{ name: string; method: InstallMethod }> = [
    { name: 'npm global', method: npmGlobal },
    { name: 'Windows bundle', method: windowsBundle },
    { name: 'pnpm global', method: { kind: 'package-manager', manager: 'pnpm', global: true } },
    { name: 'npx', method: { kind: 'npx' } },
  ];
  const methodCases = methods.flatMap(({ name, method }) =>
    (['win32', 'linux'] as const).flatMap((platform) =>
      [false, true].map((check) => ({ name, method, platform, check }))));
  it.each(methodCases)('refuses an unsafe pin for $name on $platform with check=$check', async ({ method, platform, check }) => {
    const { deps, calls } = makeDeps(method, platform);
    const result = await runUpgrade({ version: '1.2.3&calc', check }, deps);
    expect(result).toBe(1);
    expectRefusal(calls, 'v1.2.3&calc');
    for (const line of calls.logs) expect(line).not.toContain('1.2.3&calc');
  });

  it('refuses an unsafe target in the retained Windows bundle helper before PowerShell', () => {
    const { deps, calls } = makeDeps(windowsBundle, 'win32');
    const result = upgradeWindowsBundle(windowsBundle, 'v1.2.3&calc', deps);
    expect(result).toBe(1);
    expectRefusal(calls, 'v1.2.3&calc');
  });

  it.each([
    { pin: '1.6.2', normalized: 'v1.6.2' },
    { pin: 'v1.6.2-sm.14', normalized: 'v1.6.2-sm.14' },
  ])('keeps the Windows npm command for valid pin $pin', async ({ pin, normalized }) => {
    const { deps, calls } = makeDeps(npmGlobal, 'win32');
    expect(await runUpgrade({ version: pin }, deps)).toBe(0);
    expect(calls.runs[0]).toEqual({
      cmd: 'cmd.exe', args: ['/d', '/s', '/c', hubManualInstallCommand(normalized)],
    });
  });
});
