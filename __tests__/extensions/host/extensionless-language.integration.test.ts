import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extensionlessLanguage } from '../../../src/extensions/host/scan/extensionless-language';

describe('extensionlessLanguage reading files', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-shebang-read-')));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin/tool'), '#!/usr/bin/env python3\nprint(1)\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves a relative path against the root', () => {
    expect(extensionlessLanguage('bin/tool', root)).toBe('python');
  });

  it('reads an absolute path without a root', () => {
    expect(extensionlessLanguage(path.join(root, 'bin/tool'))).toBe('python');
  });

  it('returns null for a missing file', () => {
    expect(extensionlessLanguage('bin/missing', root)).toBeNull();
  });

  it('returns null for a directory', () => {
    expect(extensionlessLanguage('bin', root)).toBeNull();
  });

  it('returns null for an unreadable file', () => {
    fs.chmodSync(path.join(root, 'bin/tool'), 0o000);
    expect(extensionlessLanguage('bin/tool', root)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('returns null for a named pipe without blocking', () => {
    execFileSync('mkfifo', [path.join(root, 'bin/pipe')]);
    expect(extensionlessLanguage('bin/pipe', root)).toBeNull();
  }, 5000);

  it('returns null for a binary file', () => {
    fs.writeFileSync(path.join(root, 'bin/blob'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
    expect(extensionlessLanguage('bin/blob', root)).toBeNull();
  });

  it('recognizes the first line of a one-megabyte file', () => {
    fs.writeFileSync(path.join(root, 'bin/large'), '#!/usr/bin/env python3\n' + 'x'.repeat(1024 * 1024));
    expect(extensionlessLanguage('bin/large', root)).toBe('python');
  });

  it('rejects a dotted filename even when its file has a shebang', () => {
    fs.writeFileSync(path.join(root, 'bin/tool.py'), '#!/usr/bin/env python3\n');
    expect(extensionlessLanguage('bin/tool.py', root)).toBeNull();
  });

  it('accepts a dotted directory containing an extensionless file', () => {
    fs.mkdirSync(path.join(root, 'v2.x'));
    fs.writeFileSync(path.join(root, 'v2.x/tool'), '#!/usr/bin/env python3\n');
    expect(extensionlessLanguage('v2.x/tool', root)).toBe('python');
  });
});
