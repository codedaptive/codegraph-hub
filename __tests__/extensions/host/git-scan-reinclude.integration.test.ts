import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanDirectory, scanDirectoryAsync } from '../../../src/extraction/index';
import { clearProjectConfigCache } from '../../../src/project-config';
import { canLinkDirs } from '../../helpers/can-link-dirs';

describe.skipIf(!canLinkDirs).each([
  ['scanDirectory', scanDirectory],
  ['scanDirectoryAsync', scanDirectoryAsync],
])('%s on a git root', (_name, scan) => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    clearProjectConfigCache();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-root-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-outside-')));
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

  it('follows only an explicitly re-included outside directory link', async () => {
    fs.writeFileSync(path.join(root, '.codegraphignore'), '!data/runs\n');
    fs.mkdirSync(path.join(root, 'data'));
    fs.mkdirSync(path.join(outside, 'runs'));
    fs.mkdirSync(path.join(outside, 'other'));
    fs.writeFileSync(path.join(outside, 'runs/x.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(outside, 'other/y.ts'), 'export const y = 1;\n');
    fs.symlinkSync(path.join(outside, 'runs'), path.join(root, 'data/runs'), 'dir');
    fs.symlinkSync(path.join(outside, 'other'), path.join(root, 'data/other'), 'dir');
    commitFixture();

    const files = await scan(root);
    expect(files).toContain('src/main.ts');
    expect(files.filter(file => file.startsWith('data/other/'))).toEqual([]);
    expect(files).toContain('data/runs/x.ts');
  });

  it('indexes the real in-root directory without following its link', async () => {
    fs.mkdirSync(path.join(root, 'vendor-real'));
    fs.writeFileSync(path.join(root, 'vendor-real/a.ts'), 'export const a = 1;\n');
    fs.symlinkSync(path.join(root, 'vendor-real'), path.join(root, 'lib'), 'dir');
    commitFixture();

    const files = await scan(root);
    expect(files).toContain('vendor-real/a.ts');
    expect(files.filter(file => file.startsWith('lib/'))).toEqual([]);
  });

  it('does not follow an outside directory link without a re-include', async () => {
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(outside, 'x.ts'), 'export const x = 1;\n');
    fs.symlinkSync(outside, path.join(root, 'data/runs'), 'dir');
    commitFixture();

    const files = await scan(root);
    expect(files).toContain('src/main.ts');
    expect(files.filter(file => file.startsWith('data/runs/'))).toEqual([]);
  });
});
