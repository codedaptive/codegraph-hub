import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanDirectory, scanDirectoryAsync } from '../../../src/extraction/index';
import { clearProjectConfigCache } from '../../../src/project-config';

// Windows refuses a directory symlink with EPERM without Developer Mode or admin rights. A junction would get past
// that, but git lists a symlink as one entry and these cases test exactly that, so the cases skip instead.
const canLinkDirs = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-link-probe-'));
  try {
    fs.symlinkSync(dir, path.join(dir, 'link'), 'dir');
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return false;
    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
const linkIt = it.skipIf(!canLinkDirs);

describe('include walker symlink boundaries on a git root', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    clearProjectConfigCache();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-include-root-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-include-outside-')));
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/main.ts'), 'export const main = 1;\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  function commitFixture() {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: root });
  }

  linkIt('does not follow an outside link reached by a wildcard include', () => {
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ include: ['**/*.ts'] }));
    fs.writeFileSync(path.join(outside, 'y.ts'), 'export const y = 1;\n');
    fs.symlinkSync(outside, path.join(root, 'ext'), 'dir');
    commitFixture();

    const files = scanDirectory(root);
    expect(files).toContain('src/main.ts');
    expect(files.filter(file => file.startsWith('ext/'))).toEqual([]);
  });

  linkIt.each([
    ['scanDirectory', scanDirectory],
    ['scanDirectoryAsync', scanDirectoryAsync],
  ])('%s follows an outside link named as the include root', async (_name, scan) => {
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ include: ['data/runs/**'] }));
    fs.mkdirSync(path.join(root, 'data'));
    fs.mkdirSync(path.join(outside, 'runs'));
    fs.writeFileSync(path.join(outside, 'runs/x.ts'), 'export const x = 1;\n');
    fs.symlinkSync(path.join(outside, 'runs'), path.join(root, 'data/runs'), 'dir');
    commitFixture();

    expect(await scan(root)).toContain('data/runs/x.ts');
  });

  linkIt('follows an outside link re-included by .codegraphignore', () => {
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ include: ['**/*.ts'] }));
    fs.writeFileSync(path.join(root, '.codegraphignore'), '!ext\n');
    fs.writeFileSync(path.join(outside, 'y.ts'), 'export const y = 1;\n');
    fs.symlinkSync(outside, path.join(root, 'ext'), 'dir');
    commitFixture();

    expect(scanDirectory(root)).toContain('ext/y.ts');
  });

  linkIt('follows an in-root link below an include root', () => {
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ include: ['**/*.ts'] }));
    fs.mkdirSync(path.join(root, 'vendor-real'));
    fs.writeFileSync(path.join(root, 'vendor-real/a.ts'), 'export const a = 1;\n');
    fs.symlinkSync(path.join(root, 'vendor-real'), path.join(root, 'lib'), 'dir');
    commitFixture();

    expect(scanDirectory(root)).toContain('lib/a.ts');
  });

  it('lets include override .codegraphignore', () => {
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ include: ['src/**'] }));
    fs.writeFileSync(path.join(root, '.codegraphignore'), 'src/\n');
    commitFixture();

    expect(scanDirectory(root)).toContain('src/main.ts');
  });
});
