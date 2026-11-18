import { describe, expect, it } from 'vitest';
import { extensionlessLanguage } from '../../../src/extensions/host/scan/extensionless-language';

const python = '#!/usr/bin/env python3\nprint(1)\n';

describe('extensionlessLanguage with supplied source', () => {
  it.each(['bin/run.py', '.envrc', 'bin/tool.', 'bin\\run.py', 'bin/', 'bin\\', ''])('rejects dotted or empty basename %j', (filePath) => {
    expect(extensionlessLanguage(filePath, undefined, python)).toBeNull();
  });

  it.each(['bin/tool', 'v2.x/bin/tool', 'v2.x\\bin\\tool'])('recognizes an extensionless basename in %s', (filePath) => {
    expect(extensionlessLanguage(filePath, undefined, python)).toBe('python');
  });

  it('uses supplied source even for a nonexistent absolute file', () => {
    expect(extensionlessLanguage('/not-a-real-project/bin/tool', undefined, '#!/usr/bin/env node')).toBe('javascript');
  });

  it('does not infer a language from an unknown supplied interpreter', () => {
    expect(extensionlessLanguage('bin/tool', '/not-a-real-project', '#!/bin/sh')).toBeNull();
  });

  it('returns null for a relative path without a root or source', () => {
    expect(extensionlessLanguage('bin/tool')).toBeNull();
  });
});
