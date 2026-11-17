import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const modulePath = '../../../src/extensions/host/color/cliColorsEnabled.ts';

describe('cliColorsEnabled', () => {
  let argv: string[];
  let tty: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.resetModules();
    argv = process.argv;
    tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    process.argv = ['node', 'codegraph'];
    vi.stubEnv('NO_COLOR', undefined);
    vi.stubEnv('FORCE_COLOR', undefined);
    vi.stubEnv('CI', undefined);
    vi.stubEnv('TERM', 'xterm-256color');
  });

  afterEach(() => {
    process.argv = argv;
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
    vi.unstubAllEnvs();
  });

  it('retains --no-color over FORCE_COLOR after the flag is removed', async () => {
    vi.stubEnv('FORCE_COLOR', '1');
    process.argv.push('--no-color');
    const { cliColorsEnabled } = await import(modulePath);
    expect(cliColorsEnabled()).toBe(false);
    process.argv = process.argv.filter((a) => a !== '--no-color');
    expect(cliColorsEnabled()).toBe(false);
  });

  it('retains --color on a non-TTY after the flag is removed', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    process.argv.push('--color');
    const { cliColorsEnabled } = await import(modulePath);
    expect(cliColorsEnabled()).toBe(true);
    process.argv = process.argv.filter((a) => a !== '--color');
    expect(cliColorsEnabled()).toBe(true);
  });

  it('does not read color settings until its first call', async () => {
    vi.stubEnv('FORCE_COLOR', '1');
    const { cliColorsEnabled } = await import(modulePath);
    process.argv.push('--no-color');
    expect(cliColorsEnabled()).toBe(false);
  });
});
