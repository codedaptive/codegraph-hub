import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EndedJobsFile } from '../../../src/extensions/host/builder/ended-jobs-file';
import { stoppedIndexNote } from '../../../src/extensions/host/builder/stopped-index-note';
import { stoppedIndexWarning } from '../../../src/extensions/queries/shared/stopped-index-warning';
import { getGlyphs } from '../../../src/ui/glyphs';

let dir: string;
let root: string;
let other: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-warning-')));
  root = path.join(dir, 'repo');
  other = path.join(dir, 'other');
  fs.mkdirSync(root);
  fs.mkdirSync(other);
  vi.stubEnv('CODEGRAPH_STATE_DIR', dir);
  vi.stubEnv('NO_COLOR', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('stoppedIndexWarning', () => {
  it('returns the uncolored warning line for a marked root', () => {
    const mark = { root, kind: 'open', limit: 'time', at: '2026-11-17T10:00:00Z' } as const;
    new EndedJobsFile(path.join(dir, 'builder-ended-jobs.jsonl')).append(mark);
    const warning = stoppedIndexWarning(root);
    expect(warning).toBe(`${getGlyphs().warn} ${stoppedIndexNote(mark)}\n`);
    expect(warning).toContain(`The index builder stopped the last open job of ${root} at its time limit`);
  });

  it('colors only the glyph yellow when colors are enabled', () => {
    vi.stubEnv('NO_COLOR', '');
    vi.stubEnv('FORCE_COLOR', '1');
    const mark = { root, kind: 'open', limit: 'time', at: '2026-11-17T10:00:00Z' } as const;
    new EndedJobsFile(path.join(dir, 'builder-ended-jobs.jsonl')).append(mark);
    expect(stoppedIndexWarning(root)).toBe(`\u001b[33m${getGlyphs().warn}\u001b[0m ${stoppedIndexNote(mark)}\n`);
  });

  it('returns null when only another root is marked', () => {
    new EndedJobsFile(path.join(dir, 'builder-ended-jobs.jsonl')).append({
      root: other, kind: 'open', limit: 'time', at: '2026-11-17T10:00:00Z',
    });
    expect(stoppedIndexWarning(root)).toBeNull();
  });

  it('returns null when the marks file is missing', () => {
    expect(stoppedIndexWarning(root)).toBeNull();
  });
});
