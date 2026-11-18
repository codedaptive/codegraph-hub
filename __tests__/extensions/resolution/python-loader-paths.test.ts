/**
 * Unit tests of pythonLoaderPaths: the path expressions it evaluates (Path/os.path
 * chains, string literals, module-level names) and the lines it reports, multiline and
 * keyword calls, calls in comments and docstrings, and the dynamic, absolute, escaping,
 * ambiguous name bindings, dynamic namespace access, trusted callees and continuation
 * lines, plus production-style loader calls.
 */
import { describe, expect, it } from 'vitest';
import { pythonLoaderPaths } from '../../../src/extensions/resolution/python-loader-paths';

const file = 'tests/unit/test_a.py';

describe('pythonLoaderPaths', () => {
  it.each([
    ['Path(__file__).resolve().parents[2] / "share" / "x.py"', '/share/x.py'],
    ['Path(__file__).parent / "x.py"', '/tests/unit/x.py'],
    ['Path(__file__).parent.parent / "x.py"', '/tests/x.py'],
    ['os.path.join(os.path.dirname(__file__), "..", "lib", "x.py")', '/tests/lib/x.py'],
    ['os.path.join(os.path.dirname(os.path.abspath(__file__)), "x.py")', '/tests/unit/x.py'],
    ['pathlib.Path(os.path.normpath(os.path.realpath(__file__))).absolute().parent.joinpath("a", "b")', '/tests/unit/a/b'],
    ['os.fspath(Path(__file__).parent / "x.py")', '/tests/unit/x.py'],
    ['"share/x.py"', 'share/x.py'],
    ["'x.py'", './x.py'],
    ['r"./x.py"', './x.py'],
    ['"../lib/x.py"', '../lib/x.py'],
    ['Path("share/x.py")', 'share/x.py'],
  ])('evaluates %s', (expression, expected) => {
    expect(pythonLoaderPaths(file, `from pathlib import Path\nimport os, pathlib\nSourceFileLoader("m", ${expression})`)).toEqual([{ line: 3, name: expected }]);
  });

  it('resolves recursively assigned module names and preserves source order and lines', () => {
    const source = `from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "share" / "x.py"
loader = importlib.machinery.SourceFileLoader("codeteam_land", str(ROOT / "bin" / "codeteam-land"))
other = machinery.SourceFileLoader("m", str(SCRIPT))`;
    expect(pythonLoaderPaths(file, source)).toEqual([
      { line: 4, name: '/bin/codeteam-land' },
      { line: 5, name: '/share/x.py' },
    ]);
  });

  it('reads multiline calls and the appropriate path keywords', () => {
    const source = `from pathlib import Path
a = SourceFileLoader(
    "m",
    path=Path(__file__).parent / "x.py",
)
b = importlib.util.spec_from_file_location(
    "m", location="share/x.py"
)
c = util.spec_from_file_location("m", "other/y.py")
d = spec_from_file_location("m", "z.py")`;
    expect(pythonLoaderPaths(file, source)).toEqual([
      { line: 2, name: '/tests/unit/x.py' },
      { line: 6, name: 'share/x.py' },
      { line: 9, name: 'other/y.py' },
      { line: 10, name: './z.py' },
    ]);
  });

  it('ignores calls in comments and both styles of docstring', () => {
    const source = `# SourceFileLoader("m", "comment.py")
"""spec_from_file_location("m", "doc.py")"""
'''SourceFileLoader("m", "doc2.py")'''
SourceFileLoader("m", "real.py") # SourceFileLoader("m", "tail.py")`;
    expect(pythonLoaderPaths(file, source)).toEqual([{ line: 4, name: './real.py' }]);
  });

  it.each([
    'f"share/{name}.py"',
    '"share/" + name',
    '"%s.py" % name',
    '"{}.py".format(name)',
    'os.environ["SCRIPT"]',
    'os.getenv("SCRIPT")',
    'sys.argv[1]',
    '"/abs/x.py"',
    'Path(__file__).resolve().parents[5] / "x.py"',
  ])('rejects dynamic, absolute or escaping expression %s', (expression) => {
    expect(pythonLoaderPaths(file, `from pathlib import Path\nimport os\nSourceFileLoader("m", ${expression})`)).toEqual([]);
  });

  it('rejects a function parameter and keeps a local the file binds once', () => {
    const source = `def load(p):
    local = "share/x.py"
    SourceFileLoader("a", p)
    SourceFileLoader("b", local)`;
    expect(pythonLoaderPaths(file, source)).toEqual([{ line: 4, name: 'share/x.py' }]);
  });

  it.each([
    ['parameter', 'def load(path):'],
    ['variadic positional parameter', 'def load(*path):'],
    ['variadic keyword parameter', 'def load(**path):'],
    ['defaulted and annotated parameter', 'def load(path: str = "default.py"):'],
    ['multiline parameter', 'def load(\n    path: str = "default.py",\n):'],
  ])('does not resolve a module name shadowed by a %s', (_description, signature) => {
    const source = `from pathlib import Path
path = Path(__file__).parent / "x.py"
${signature}
    return SourceFileLoader("m", path)`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it.each([
    ['assignment', 'ROOT = Path("elsewhere")'],
    ['annotated assignment', 'ROOT: str = "elsewhere"'],
    ['augmented assignment', 'ROOT += "elsewhere"'],
    ['for target', 'for ROOT in paths:\n        pass'],
    ['with target', 'with context() as ROOT:\n        pass'],
  ])('does not resolve a module name shadowed by a local %s', (_description, binding) => {
    const source = `from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
def load():
    ${binding}
    return SourceFileLoader("m", str(ROOT / "x.py"))`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it('does not resolve a name bound in an enclosing function', () => {
    const source = `from pathlib import Path
path = Path(__file__).parent / "x.py"
def outer(path):
    def inner():
        return SourceFileLoader("m", path)`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it('rejects a module name everywhere when a function parameter binds it', () => {
    const source = `from pathlib import Path
path = Path(__file__).parent / "x.py"
def other(path):
    pass
SourceFileLoader("m", path)
def load():
    return SourceFileLoader("m", path)`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it('does not treat a keyword on a continuation line as a module binding', () => {
    const source = `x = configure(
path="s.py"
)
SourceFileLoader("m", path)`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it('rejects a module name rebound in an if block', () => {
    const source = `from pathlib import Path
ROOT = Path(__file__).parent
if SHIFT:
    ROOT = Path(__file__).parents[2]
SourceFileLoader("m", str(ROOT / "x.py"))`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it('rejects a module name rebound in an except block', () => {
    const source = `from pathlib import Path
ROOT = Path(__file__).parent
try:
    import x
except ImportError:
    ROOT = Path(__file__).parents[2]
SourceFileLoader("m", str(ROOT / "x.py"))`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it('rejects a module name rebound by a module-level for target', () => {
    const source = `from pathlib import Path
ROOT = Path(__file__).parent
for ROOT in []:
    pass
SourceFileLoader("m", str(ROOT / "x.py"))`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it('rejects a name declared global in a function', () => {
    const source = `from pathlib import Path
ROOT = Path(__file__).parent
def reset():
    global ROOT
    ROOT = Path(__file__).parents[2]
SourceFileLoader("m", str(ROOT / "x.py"))`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it('resolves a name bound once in a module-level block', () => {
    const source = `from pathlib import Path
if True:
    ROOT = Path(__file__).parent
SourceFileLoader("m", str(ROOT / "x.py"))`;
    expect(pythonLoaderPaths(file, source)).toEqual([{ line: 4, name: '/tests/unit/x.py' }]);
  });

  it('rejects a module name also bound as a class attribute', () => {
    const source = `from pathlib import Path
ROOT = Path(__file__).parent
class C:
    ROOT = 1
SourceFileLoader("m", str(ROOT / "x.py"))`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it.each([
    ['import', 'import ROOT'],
    ['from import', 'from m import ROOT'],
    ['one-line if assignment', 'if X: ROOT = Path("a")'],
    ['one-line else assignment', 'if X: pass\nelse: ROOT = Path("a")'],
    ['one-line try assignment', 'try: ROOT = Path("a")\nexcept Exception: pass'],
    ['one-line global assignment', 'def f(): global ROOT; ROOT = 1'],
    ['semicolon assignment', 'x = 1; ROOT = Path("a")'],
    ['chained assignment', 'A = ROOT = Path("a")'],
    ['assignment expression', 'if (ROOT := Path("a")): pass'],
    ['star import', 'from m import *'],
    ['globals mutation', 'globals()["ROOT"] = 1'],
    ['string reference', 'patch("m.ROOT")'],
  ])('rejects a module path after a possible %s binding', (_description, statement) => {
    const source = `from pathlib import Path
ROOT = Path(__file__).parent
${statement}
SourceFileLoader("m", str(ROOT / "x.py"))`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it('rejects a module path when a class body also binds it', () => {
    const source = `from pathlib import Path
ROOT = Path(__file__).parent
class C:
    ROOT = 1
    SourceFileLoader("m", str(ROOT / "x.py"))`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it('rejects a path through join imported from an untrusted module', () => {
    const source = `from pathlib import Path
from mylib import join
import os
ROOT = Path(__file__).parent
SourceFileLoader("m", join(os.path.dirname(__file__), "x.py"))`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it('rejects an anchored path after __file__ is rebound', () => {
    const source = `from pathlib import Path
__file__ = "other.py"
SourceFileLoader("m", Path(__file__).parent / "x.py")`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it('resolves a production importlib spec with sys.path and exec_module', () => {
    const source = `from pathlib import Path
import importlib.util
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "share"))
spec = importlib.util.spec_from_file_location("m", ROOT / "share" / "x.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)`;
    expect(pythonLoaderPaths(file, source)).toEqual([{ line: 5, name: '/share/x.py' }]);
  });

  it('resolves a production loader inside setUp', () => {
    const source = `from pathlib import Path
import importlib.machinery
ROOT = Path(__file__).resolve().parents[2]
def setUp(self):
    loader = importlib.machinery.SourceFileLoader("codeteam_land", str(ROOT / "bin" / "codeteam-land"))`;
    expect(pythonLoaderPaths(file, source)).toEqual([{ line: 5, name: '/bin/codeteam-land' }]);
  });

  it('rejects multiply assigned module names and their dependent aliases', () => {
    const source = `from pathlib import Path
ROOT = Path(__file__).parent
ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "share" / "x.py"
SourceFileLoader("a", str(ROOT / "a.py"))
SourceFileLoader("b", str(SCRIPT))`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });
});
