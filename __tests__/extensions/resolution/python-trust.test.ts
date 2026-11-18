/**
 * Unit tests of pythonTrust: `__file__` trusted only when nothing may bind it, a bare
 * callee only when its every possible binding (none included) is an unaliased from-import
 * of a path module, a word of a dotted callee only when its every possible binding is an
 * unaliased from-import or plain import of it, and nothing for a dynamic file. The dotted
 * forms read real source through pythonNameBindings, so a string occurrence counts.
 */
import { describe, expect, it } from 'vitest';
import { pythonNameBindings } from '../../../src/extensions/resolution/python-name-bindings';
import { pythonTrust } from '../../../src/extensions/resolution/python-trust';

const trustOf = (bindings: Record<string, string[]>) => pythonTrust(new Map(Object.entries(bindings)));
const trustOfSource = (source: string) => pythonTrust(pythonNameBindings(source));

describe('pythonTrust', () => {
  it('trusts callees and dotted words bound only by their imports, and an unbound __file__', () => {
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
      path: ['import os.path'],
    });
    expect(trust.file).toBe(true);
    for (const word of ['Path', 'PurePath', 'join', 'dirname', 'fspath', 'abspath']) expect(trust.names.has(word)).toBe(true);
    for (const word of ['Path', 'join', 'dirname', 'os', 'pathlib', 'posixpath', 'path']) expect(trust.dotted.has(word)).toBe(true);
  });

  it('trusts every word nothing may bind (a builtin, or NameError at run time)', () => {
    const callees = ['Path', 'PurePath', 'PosixPath', 'PurePosixPath', 'str', 'fspath', 'abspath', 'realpath', 'normpath', 'dirname', 'join'];
    expect(trustOf({})).toEqual({
      file: true,
      names: new Set(callees),
      dotted: new Set([...callees, 'os', 'path', 'posixpath', 'pathlib']),
    });
  });

  it.each([
    ['from another module', { join: ['from mylib import join'] }, 'join'],
    ['aliased in its import', { join: ['from os.path import join as j'] }, 'join'],
    ['imported as an alias', { join: ['from os.path import dirname as join'] }, 'join'],
    ['also assigned', { Path: ['from pathlib import Path', 'Path = mylib.Path'] }, 'Path'],
    ['beside another statement', { Path: ['from pathlib import Path; Path = 1'] }, 'Path'],
    ['bound at all, for str', { str: ['str = 1'] }, 'str'],
    ['imported plainly, for a bare callee', { join: ['import join'] }, 'join'],
  ])('does not trust a bare callee %s', (_case, bindings, word) => {
    expect(trustOf(bindings).names.has(word)).toBe(false);
  });

  it.each([
    ['a module from-imported', { os: ['from mylib import os'] }, 'os'],
    ['a module aliased', { os: ['import mylib as os'] }, 'os'],
    ['a middle word assigned', { path: ['os.path = x'] }, 'path'],
    ['a final word in a string', { join: ['with mock.patch.object(os.path, "join", return_value="x"):'] }, 'join'],
  ])('does not trust a dotted word %s', (_case, bindings, word) => {
    expect(trustOf(bindings).dotted.has(word)).toBe(false);
  });

  it.each([
    ['its final name is patched by string', 'import os\nwith mock.patch.object(os.path, "join", return_value="x"):\n    pass', 'join'],
    ['its middle name is assigned on an alias', 'import os\nmod = os\nmod.path = fake', 'path'],
    ['its middle name is assigned on its module', 'import os\nos.path = x', 'path'],
    ['its head is rebound', 'import os\nos = mylib', 'os'],
  ])('does not trust os.path.join when %s', (_case, source, word) => {
    expect(trustOfSource(source).dotted.has(word)).toBe(false);
  });

  it('trusts every word of os.path.join in a file that only imports os', () => {
    const { dotted } = trustOfSource('import os\nx = os.path.join(os.path.dirname(__file__), "x.py")');
    expect(['os', 'path', 'join', 'dirname'].filter((word) => !dotted.has(word))).toEqual([]);
  });

  it('does not trust __file__ that may be bound', () => {
    expect(trustOf({ __file__: ['__file__ = "x.py"'] }).file).toBe(false);
  });

  it('trusts nothing in a dynamic file', () => {
    expect(pythonTrust(null)).toEqual({ file: false, names: new Set(), dotted: new Set() });
  });
});
