import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stoppedRootMark } from '../../../src/extensions/host/builder/stopped-root-mark';
import { warnStoppedIndex } from '../../../src/extensions/resolution/warn-stopped-index';

vi.mock('../../../src/extensions/host/builder/stopped-root-mark', () => ({ stoppedRootMark: vi.fn() }));
vi.mock('../../../src/ui/glyphs', () => ({ getGlyphs: () => ({ warn: '[WARN]' }) }));

const mark = { root: '/proj', kind: 'sync' as const, limit: 'time' as const, at: '2026-11-17T00:00:00.000Z' };
const note = 'The index builder stopped the last sync job of /proj at its time limit, ' +
  'so this index may be partial or behind. ' +
  'If the limit is too low, raise CODEGRAPH_BUILDER_JOB_MAX_MS in the environment the codegraph server starts from, ' +
  'then run `codegraph index /proj`.';

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => vi.restoreAllMocks());

describe('warnStoppedIndex', () => {
  it('writes nothing and resolves when the root has no mark', async () => {
    vi.mocked(stoppedRootMark).mockReturnValue(null);
    await expect(warnStoppedIndex('/indexed')).resolves.toBeUndefined();
    expect(stoppedRootMark).toHaveBeenCalledExactlyOnceWith('/indexed');
    expect(process.stderr.write).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it('writes one bare-glyph note to stderr', async () => {
    vi.mocked(stoppedRootMark).mockReturnValue(mark);
    await warnStoppedIndex('/indexed');
    expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(`[WARN] ${note}\n`);
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(stoppedRootMark).toHaveBeenCalledExactlyOnceWith('/indexed');
  });

  it('uses the marked job and memory limit in the note', async () => {
    vi.mocked(stoppedRootMark).mockReturnValue({ ...mark, root: '/other', kind: 'cold-build', limit: 'rss' });
    await warnStoppedIndex('/indexed');
    expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(
      '[WARN] The index builder stopped the last cold-build job of /other at its memory limit, ' +
      'so this index may be partial or behind. ' +
      'If the limit is too low, raise CODEGRAPH_BUILDER_JOB_MAX_RSS_MB in the environment the codegraph server starts from, ' +
      'then run `codegraph index /other`.\n',
    );
    expect(process.stdout.write).not.toHaveBeenCalled();
  });
});
