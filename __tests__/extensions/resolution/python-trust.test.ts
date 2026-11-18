/**
 * Unit tests of pythonTrust over hand-written possible-binding maps: `__file__` trusted
 * only when nothing may bind it, a bare callee only when its every possible binding (none
 * included) is an unaliased from-import of a path module, a module only when its every
 * possible binding is an unaliased plain import, and nothing for a dynamic file.
 */
import { describe, expect, it } from 'vitest';
import { pythonTrust } from '../../../src/extensions/resolution/python-trust';

const trustOf = (bindings: Record<string, string[]>) => pythonTrust(new Map(Object.entries(bindings)));

describe('pythonTrust', () => {
  it('trusts callees and modules bound only by their imports, and an unbound __file__', () => {
    const trust = trustOf({
      Path: ['from pathlib import Path, PurePath'],
      PurePath: ['from pathlib import Path, PurePath'],
      join: ['from os.path import (\n    join,\n    dirname,\n)'],
      dirname: ['from os.path import (\n    join,\n    dirname,\n)'],
      fspath: ['from os import fspath'],
      abspath: ['from posixpath import abspath'],
      os: ['import os, pathlib'],
      pathlib: ['import os, pathlib'],
      posixpath: ['import posixpath'],
    });
    expect(trust.file).toBe(true);
    for (const word of ['Path', 'PurePath', 'join', 'dirname', 'fspath', 'abspath', 'os', 'pathlib', 'posixpath']) {
      expect(trust.names.has(word)).toBe(true);
    }
  });

  it('trusts every callee and module nothing may bind (a builtin, or NameError at run time)', () => {
    expect(trustOf({}).names).toEqual(new Set([
      'Path', 'PurePath', 'PosixPath', 'PurePosixPath', 'str', 'fspath', 'abspath', 'realpath', 'normpath', 'dirname', 'join',
      'os', 'posixpath', 'pathlib',
    ]));
  });

  it.each([
    ['from another module', { join: ['from mylib import join'] }, 'join'],
    ['aliased in its import', { join: ['from os.path import join as j'] }, 'join'],
    ['imported as an alias', { join: ['from os.path import dirname as join'] }, 'join'],
    ['also assigned', { Path: ['from pathlib import Path', 'Path = mylib.Path'] }, 'Path'],
    ['beside another statement', { Path: ['from pathlib import Path; Path = 1'] }, 'Path'],
    ['bound at all, for str', { str: ['str = 1'] }, 'str'],
    ['a module from-imported', { os: ['from mylib import os'] }, 'os'],
    ['a module aliased', { os: ['import mylib as os'] }, 'os'],
  ])('does not trust a word %s', (_case, bindings, word) => {
    expect(trustOf(bindings).names.has(word)).toBe(false);
  });

  it('does not trust __file__ that may be bound', () => {
    expect(trustOf({ __file__: ['__file__ = "x.py"'] }).file).toBe(false);
  });

  it('trusts nothing in a dynamic file', () => {
    expect(pythonTrust(null)).toEqual({ file: false, names: new Set() });
  });
});
