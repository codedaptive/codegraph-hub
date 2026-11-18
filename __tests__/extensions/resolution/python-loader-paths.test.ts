/**
 * Unit tests of pythonLoaderPaths: the path expressions it evaluates (Path/os.path
 * chains, string literals, module-level names) and the lines it reports, multiline and
 * keyword calls, calls in comments and docstrings, and the dynamic, absolute, escaping,
 * local-only, shadowed and multiply assigned forms it refuses, and continuation lines
 * that are not module bindings.
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
    expect(pythonLoaderPaths(file, `SourceFileLoader("m", ${expression})`)).toEqual([{ line: 1, name: expected }]);
  });

  it('resolves recursively assigned module names and preserves source order and lines', () => {
    const source = `ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "share" / "x.py"
loader = importlib.machinery.SourceFileLoader("codeteam_land", str(ROOT / "bin" / "codeteam-land"))
other = machinery.SourceFileLoader("m", str(SCRIPT))`;
    expect(pythonLoaderPaths(file, source)).toEqual([
      { line: 3, name: '/bin/codeteam-land' },
      { line: 4, name: '/share/x.py' },
    ]);
  });

  it('reads multiline calls and the appropriate path keywords', () => {
    const source = `a = SourceFileLoader(
    "m",
    path=Path(__file__).parent / "x.py",
)
b = importlib.util.spec_from_file_location(
    "m", location="share/x.py"
)
c = util.spec_from_file_location("m", "other/y.py")
d = spec_from_file_location("m", "z.py")`;
    expect(pythonLoaderPaths(file, source)).toEqual([
      { line: 1, name: '/tests/unit/x.py' },
      { line: 5, name: 'share/x.py' },
      { line: 8, name: 'other/y.py' },
      { line: 9, name: './z.py' },
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
    expect(pythonLoaderPaths(file, `SourceFileLoader("m", ${expression})`)).toEqual([]);
  });

  it('rejects function parameters and local assignments', () => {
    const source = `def load(p):
    local = "share/x.py"
    SourceFileLoader("a", p)
    SourceFileLoader("b", local)`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it.each([
    ['parameter', 'def load(path):'],
    ['variadic positional parameter', 'def load(*path):'],
    ['variadic keyword parameter', 'def load(**path):'],
    ['defaulted and annotated parameter', 'def load(path: str = "default.py"):'],
    ['multiline parameter', 'def load(\n    path: str = "default.py",\n):'],
  ])('does not resolve a module name shadowed by a %s', (_description, signature) => {
    const source = `path = Path(__file__).parent / "x.py"
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
    const source = `ROOT = Path(__file__).resolve().parents[2]
def load():
    ${binding}
    return SourceFileLoader("m", str(ROOT / "x.py"))`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it('does not resolve a name bound in an enclosing function', () => {
    const source = `path = Path(__file__).parent / "x.py"
def outer(path):
    def inner():
        return SourceFileLoader("m", path)`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it('keeps a module name visible outside the function that shadows it', () => {
    const source = `path = Path(__file__).parent / "x.py"
def other(path):
    pass
SourceFileLoader("m", path)
def load():
    return SourceFileLoader("m", path)`;
    expect(pythonLoaderPaths(file, source)).toEqual([
      { line: 4, name: '/tests/unit/x.py' },
      { line: 6, name: '/tests/unit/x.py' },
    ]);
  });

  it('does not treat a keyword on a continuation line as a module binding', () => {
    const source = `x = configure(
path="s.py"
)
SourceFileLoader("m", path)`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });

  it('rejects multiply assigned module names and their dependent aliases', () => {
    const source = `ROOT = Path(__file__).parent
ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "share" / "x.py"
SourceFileLoader("a", str(ROOT / "a.py"))
SourceFileLoader("b", str(SCRIPT))`;
    expect(pythonLoaderPaths(file, source)).toEqual([]);
  });
});
