import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const modulePath = '../../../src/extensions/host/color/cliColorsEnabled.ts';
const seamFile = fileURLToPath(new URL(modulePath, import.meta.url));

describe('project CLI color flags', () => {
  let workspace: string;
  let argv: string[];
  let tty: PropertyDescriptor | undefined;
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    argv = process.argv;
    tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    process.argv = ['node', 'codegraph', 'project', 'list'];
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-project-color-')));
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    vi.stubEnv('NO_COLOR', undefined);
    vi.stubEnv('FORCE_COLOR', undefined);
    vi.stubEnv('CI', undefined);
    vi.stubEnv('TERM', 'xterm-256color');
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = argv;
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function listAfterStartup(flag: string): Promise<void> {
    process.argv.push(flag);
    if (fs.existsSync(seamFile)) {
      const { cliColorsEnabled } = await import(modulePath);
      cliColorsEnabled();
    }
    process.argv = process.argv.filter((a) => a !== '--color' && a !== '--no-color');
    const { runProjectList } = await import('../../../src/extensions/host/worktree-lifecycle/cli');
    runProjectList({});
  }

  it('prints no ANSI escapes for --no-color even with forced color and a TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    vi.stubEnv('FORCE_COLOR', '1');
    await listAfterStartup('--no-color');
    expect(log).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0][0])).toContain('No registered projects.');
    expect([...log.mock.calls, ...error.mock.calls].every((line) => !line.some((part) => String(part).includes('\x1b[')))).toBe(true);
  });

  it('prints an ANSI-colored glyph for --color on a non-TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    await listAfterStartup('--color');
    expect(log).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0][0])).toContain('No registered projects.');
    expect(String(log.mock.calls[0][0])).toContain('\x1b[');
  });
});
