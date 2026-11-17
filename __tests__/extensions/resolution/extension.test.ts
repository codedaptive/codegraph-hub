import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findNearestCodeGraphRoot } from '../../../src/directory';
import { stoppedRootMark } from '../../../src/extensions/host/builder/stopped-root-mark';
import { findSuspects } from '../../../src/extensions/resolution/suspects';
import { registerSuspectsCommand } from '../../../src/extensions/resolution/extension';

vi.mock('../../../src/directory', () => ({ findNearestCodeGraphRoot: vi.fn() }));
vi.mock('../../../src/extensions/host/builder/stopped-root-mark', () => ({ stoppedRootMark: vi.fn() }));
vi.mock('../../../src/extensions/resolution/suspects', () => ({
  findSuspects: vi.fn(),
  formatSuspects: vi.fn(() => 'known suspects'),
  suspectsToJson: vi.fn(() => ({ version: 1, suspects: [] })),
}));
vi.mock('../../../src/ui/color', () => ({ ansiColorsEnabled: vi.fn(() => false) }));
vi.mock('../../../src/ui/glyphs', () => ({ getGlyphs: () => ({ warn: '[WARN]' }) }));

const mark = { root: '/proj', kind: 'sync' as const, limit: 'time' as const, at: '2026-11-17T00:00:00.000Z' };
const warning = '[WARN] The index builder stopped the last sync job of /proj at its time limit, ' +
  'so this index may be partial or behind. ' +
  'If the limit is too low, raise CODEGRAPH_BUILDER_JOB_MAX_MS in the environment the codegraph server starts from, ' +
  'then run `codegraph index /proj`.\n';
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  previousExitCode = process.exitCode;
  vi.clearAllMocks();
  vi.mocked(findNearestCodeGraphRoot).mockReset().mockReturnValue('/proj');
  vi.mocked(findSuspects).mockReset().mockReturnValue([]);
  vi.mocked(stoppedRootMark).mockReturnValue(null);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = previousExitCode;
});

async function run(...args: string[]) {
  const events: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  vi.mocked(process.stdout.write).mockImplementation((chunk) => {
    events.push({ stream: 'stdout', text: String(chunk) });
    return true;
  });
  vi.mocked(process.stderr.write).mockImplementation((chunk) => {
    events.push({ stream: 'stderr', text: String(chunk) });
    return true;
  });
  process.exitCode = undefined;
  const program = new Command();
  registerSuspectsCommand(program);
  await program.parseAsync(['node', 'codegraph', 'suspects', '-p', '/some/path', ...args]);
  return {
    stdout: events.filter((event) => event.stream === 'stdout').map((event) => event.text).join(''),
    stderr: events.filter((event) => event.stream === 'stderr').map((event) => event.text).join(''),
    events,
    exitCode: process.exitCode,
  };
}

describe('suspects stopped-index warning', () => {
  it('writes the marked-root note before unchanged text output and succeeds', async () => {
    const unmarked = await run();
    vi.mocked(stoppedRootMark).mockReturnValue(mark);
    const marked = await run();
    expect(marked.stderr).toBe(warning);
    expect(marked.stdout).toBe('known suspects\n');
    expect(marked.stdout).toBe(unmarked.stdout);
    expect(marked.events).toEqual([
      { stream: 'stderr', text: warning },
      { stream: 'stdout', text: 'known suspects\n' },
    ]);
    expect(marked.exitCode).toBe(0);
    expect(stoppedRootMark).toHaveBeenCalledWith('/proj');
  });

  it('writes unchanged text output without a note for an unmarked root', async () => {
    const result = await run();
    expect(result.stdout).toBe('known suspects\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps marked JSON output parseable and identical to unmarked JSON', async () => {
    const unmarked = await run('--json');
    vi.mocked(stoppedRootMark).mockReturnValue(mark);
    const marked = await run('--json');
    expect(marked.stderr).toBe(warning);
    expect(JSON.parse(marked.stdout)).toEqual({ version: 1, suspects: [] });
    expect(marked.stdout).toBe(unmarked.stdout);
    expect(marked.exitCode).toBe(0);
  });

  it('writes only the no-root error and fails even if a mark would be returned', async () => {
    vi.mocked(findNearestCodeGraphRoot).mockReturnValue(null);
    vi.mocked(stoppedRootMark).mockReturnValue(mark);
    const result = await run();
    expect(result.stderr).toBe('✗ No CodeGraph index at or above /some/path. Run `codegraph init` in the project first.\n');
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('writes only the suspects failure and fails even if a mark would be returned', async () => {
    vi.mocked(stoppedRootMark).mockReturnValue(mark);
    vi.mocked(findSuspects).mockImplementation(() => { throw new Error('index broken'); });
    const result = await run();
    expect(result.stderr).toBe('✗ suspects failed: index broken\n');
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(1);
  });
});
