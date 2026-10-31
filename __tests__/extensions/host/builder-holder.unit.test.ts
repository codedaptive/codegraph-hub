/**
 * `isIndexedFileStateCurrent` (src/extensions/host/builder/holder.ts): the filter the builder's watcher gets on
 * Windows to drop NTFS last-access notifications, a copy of `CodeGraph`'s private check built on `getFile`.
 *
 * The predicate itself is platform-neutral, so it runs here on POSIX against a real index and real files. That
 * the watcher is given it only on win32 is not exercised: no Windows machine runs this suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { isIndexedFileStateCurrent } from '../../../src/extensions/host/builder/holder';

describe('isIndexedFileStateCurrent', { timeout: 60_000 }, () => {
  let root: string;
  let cg: CodeGraph;
  const file = (rel: string): string => path.join(root, rel);

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-builder-holder-')));
    fs.mkdirSync(file('src'), { recursive: true });
    fs.writeFileSync(file('src/a.ts'), 'export function a() { return 1; }\n');
    fs.writeFileSync(file('src/gone.ts'), 'export function gone() { return 2; }\n');
    const init = await CodeGraph.init(root);
    try { await init.indexAll(); } finally { init.close(); }
    cg = CodeGraph.openSync(root, { readOnly: true });
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is true for an indexed file whose size and mtime still match the index', () => {
    expect(cg.getFile('src/a.ts')).not.toBeNull();
    expect(isIndexedFileStateCurrent(cg, root, 'src/a.ts')).toBe(true);
  });

  it('is false once the mtime moved', () => {
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file('src/a.ts'), later, later);
    expect(isIndexedFileStateCurrent(cg, root, 'src/a.ts')).toBe(false);
  });

  it('is false once the size changed, even with the mtime put back', () => {
    const before = fs.statSync(file('src/a.ts'));
    fs.appendFileSync(file('src/a.ts'), '// more\n');
    fs.utimesSync(file('src/a.ts'), before.atime, before.mtime);
    expect(isIndexedFileStateCurrent(cg, root, 'src/a.ts')).toBe(false);
  });

  it('is false for a file the index does not track', () => {
    fs.writeFileSync(file('src/untracked.ts'), 'export const u = 1;\n');
    expect(isIndexedFileStateCurrent(cg, root, 'src/untracked.ts')).toBe(false);
  });

  it('is false for an indexed file that is now missing, so its removal reaches the sync', () => {
    expect(cg.getFile('src/gone.ts')).not.toBeNull();
    fs.rmSync(file('src/gone.ts'));
    expect(isIndexedFileStateCurrent(cg, root, 'src/gone.ts')).toBe(false);
  });

  it('is false when the graph is gone or cannot be read', () => {
    expect(isIndexedFileStateCurrent(null, root, 'src/a.ts')).toBe(false);
    const throwing = { getFile: () => { throw new Error('closed'); } };
    expect(isIndexedFileStateCurrent(throwing, root, 'src/a.ts')).toBe(false);
  });
});
