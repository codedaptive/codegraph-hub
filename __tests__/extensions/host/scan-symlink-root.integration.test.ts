import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanDirectory } from '../../../src/extraction/index';

describe('scanDirectory symlink root boundary', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scan-root-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scan-outside-')));
    expect(() => execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' })).toThrow();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/main.ts'), 'export const main = 1;\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('skips a link to an outside directory', () => {
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(outside, 'x.ts'), 'export const x = 1;\n');
    fs.symlinkSync(outside, path.join(root, 'data/runs'), 'dir');

    const files = scanDirectory(root);
    expect(files).toContain('src/main.ts');
    expect(files.filter(file => file.startsWith('data/runs/'))).toEqual([]);
  });

  it('follows a link to an ignored directory inside the root', () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'vendor-real/\n');
    fs.mkdirSync(path.join(root, 'vendor-real'));
    fs.writeFileSync(path.join(root, 'vendor-real/a.ts'), 'export const a = 1;\n');
    fs.symlinkSync(path.join(root, 'vendor-real'), path.join(root, 'lib'), 'dir');

    const files = scanDirectory(root);
    expect(files).toContain('src/main.ts');
    expect(files).toContain('lib/a.ts');
    expect(files).not.toContain('vendor-real/a.ts');
  });

  it('follows only the re-included link to an outside directory', () => {
    fs.writeFileSync(path.join(root, '.codegraphignore'), '!data/runs\n');
    fs.mkdirSync(path.join(root, 'data'));
    fs.mkdirSync(path.join(outside, 'runs'));
    fs.mkdirSync(path.join(outside, 'other'));
    fs.writeFileSync(path.join(outside, 'runs/x.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(outside, 'other/y.ts'), 'export const y = 1;\n');
    fs.symlinkSync(path.join(outside, 'runs'), path.join(root, 'data/runs'), 'dir');
    fs.symlinkSync(path.join(outside, 'other'), path.join(root, 'data/other'), 'dir');

    const files = scanDirectory(root);
    expect(files).toContain('src/main.ts');
    expect(files).toContain('data/runs/x.ts');
    expect(files.filter(file => file.startsWith('data/other/'))).toEqual([]);
  });

  it('excludes an in-root directory ignored by .codegraphignore', () => {
    fs.writeFileSync(path.join(root, '.codegraphignore'), 'gen/\n');
    fs.mkdirSync(path.join(root, 'gen'));
    fs.writeFileSync(path.join(root, 'gen/g.ts'), 'export const g = 1;\n');

    const files = scanDirectory(root);
    expect(files).toContain('src/main.ts');
    expect(files).not.toContain('gen/g.ts');
  });
});
