/**
 * Indexes a temporary Python project and checks that getFileDependents sees a test that
 * loads a file by path with SourceFileLoader or spec_from_file_location (anchored on
 * `__file__`, root-relative, loader-relative), that a path from a function parameter
 * links nothing even when it shadows a module name, and that the dependency returns after
 * the target is deleted and re-added across syncs. A local bound once in a function is
 * read like a module name; a parameter links nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';

let root: string;
let cg: CodeGraph;
const xContent = 'def x():\n    return 1\n';

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-python-path-loaded-'));
  fs.mkdirSync(path.join(root, 'share'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests/unit'), { recursive: true });
  fs.writeFileSync(path.join(root, 'share/x.py'), xContent);
  fs.writeFileSync(path.join(root, 'share/y.py'), 'def y():\n    return 2\n');
  fs.writeFileSync(path.join(root, 'share/z.py'), 'def z():\n    return 3\n');
  fs.writeFileSync(path.join(root, 'share/v.py'), 'def v():\n    return 5\n');
  fs.writeFileSync(path.join(root, 'lib/w.py'), 'def w():\n    return 4\n');
  fs.writeFileSync(path.join(root, 'tests/unit/test_a.py'), `from pathlib import Path
import importlib.machinery
ROOT = Path(__file__).resolve().parents[2]
loader = importlib.machinery.SourceFileLoader("x", str(ROOT / "share" / "x.py"))
mod = loader.load_module()
`);
  fs.writeFileSync(path.join(root, 'tests/test_b.py'), `import importlib.util
spec = importlib.util.spec_from_file_location("y", "share/y.py")
`);
  fs.writeFileSync(path.join(root, 'tests/test_c.py'), `import importlib.util
spec = importlib.util.spec_from_file_location("w", "../lib/w.py")
`);
  fs.writeFileSync(path.join(root, 'tests/test_d.py'), `import importlib.machinery, sys
def load(p):
    return importlib.machinery.SourceFileLoader("z", p).load_module()
`);
  fs.writeFileSync(path.join(root, 'tests/test_e.py'), `import importlib.machinery
from pathlib import Path
path = str(Path(__file__).resolve().parents[1] / "share" / "v.py")
def load(path):
    return importlib.machinery.SourceFileLoader("v", path).load_module()
`);
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('Python path-loaded file dependents', () => {
  it('finds the loader for an anchored SourceFileLoader path', () => {
    expect(cg.getFileDependents('share/x.py')).toContain('tests/unit/test_a.py');
  });

  it('finds the loader for a root-relative spec location', () => {
    expect(cg.getFileDependents('share/y.py')).toContain('tests/test_b.py');
  });

  it('finds the loader for a location relative to its directory', () => {
    expect(cg.getFileDependents('lib/w.py')).toContain('tests/test_c.py');
  });

  it('does not link an unknown function parameter to a file', () => {
    expect(cg.getFileDependents('share/z.py')).not.toContain('tests/test_d.py');
  });

  it('does not link a parameter that shadows a module path', () => {
    expect(cg.getFileDependents('share/v.py')).not.toContain('tests/test_e.py');
  });

  it('restores the dependency when a deleted target is reintroduced and synced', async () => {
    fs.unlinkSync(path.join(root, 'share/x.py'));
    await cg.sync();
    fs.writeFileSync(path.join(root, 'share/x.py'), xContent);
    await cg.sync();
    expect(cg.getFileDependents('share/x.py')).toContain('tests/unit/test_a.py');
  });
});
