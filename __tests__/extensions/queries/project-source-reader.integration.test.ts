import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectSourceReader } from '../../../src/extensions/queries/shared/projectSourceReader';

let parent = '';
let root = '';

beforeAll(() => {
  parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-project-source-')));
  fs.mkdirSync(path.join(parent, 'project', 'src'), { recursive: true });
  root = fs.realpathSync(path.join(parent, 'project'));
  fs.writeFileSync(path.join(root, 'src', 'a.rs'), 'fn main() { println!("hello"); }\n');
  fs.writeFileSync(path.join(parent, 'outside.txt'), 'outside secret\n');
});

afterAll(() => {
  if (parent) fs.rmSync(parent, { recursive: true, force: true });
});

describe('projectSourceReader', () => {
  it('reads a project-relative file as UTF-8 text', () => {
    expect(projectSourceReader(root)('src/a.rs')).toBe('fn main() { println!("hello"); }\n');
  });

  it('returns undefined for a missing file', () => {
    expect(projectSourceReader(root)('src/missing.rs')).toBeUndefined();
  });

  it('refuses a path traversing outside the project', () => {
    expect(projectSourceReader(root)('../outside.txt')).toBeUndefined();
  });

  it('refuses a symlink to a file outside the project', ({ skip }) => {
    let failure: unknown;
    try {
      fs.symlinkSync(path.join(parent, 'outside.txt'), path.join(root, 'src', 'outside-link.txt'));
    } catch (error) {
      failure = error;
    }
    if (failure) skip(`Cannot create a symlink on this platform: ${String(failure)}`);
    expect(projectSourceReader(root)('src/outside-link.txt')).toBeUndefined();
  });

  it('caches each path per reader while a new reader sees changed text', () => {
    const file = path.join(root, 'src', 'cached.rs');
    fs.writeFileSync(file, 'first text\n');
    const reader = projectSourceReader(root);
    expect(reader('src/cached.rs')).toBe('first text\n');
    fs.writeFileSync(file, 'new text\n');
    expect(reader('src/cached.rs')).toBe('first text\n');
    expect(projectSourceReader(root)('src/cached.rs')).toBe('new text\n');
  });
});
