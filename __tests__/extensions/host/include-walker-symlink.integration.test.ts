import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanDirectory, scanDirectoryAsync } from '../../../src/extraction/index';
import { clearProjectConfigCache } from '../../../src/project-config';
import { canLinkDirs } from '../../helpers/can-link-dirs';

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
    // The include walk visits each real folder once, so if it reached vendor-real/ first it would skip lib/.
    // Excluding vendor-real/ keeps the walk out of it, leaving the link as the only way in.
    fs.writeFileSync(
      path.join(root, 'codegraph.json'),
      JSON.stringify({ include: ['**/*.ts'], exclude: ['vendor-real/'] }),
    );
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
