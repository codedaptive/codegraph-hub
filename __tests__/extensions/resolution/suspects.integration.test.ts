/**
 * Suspect call edges: name-only `calls` edges ranked by how likely they are wrong
 * (std-collision, missing-import, several-definitions, low-confidence).
 *
 * Most describes build a real project in a temp dir, index it with a real CodeGraph, close it,
 * and read it back through `findSuspects` (which opens the DB read-only); some build two, and
 * the invalid-metadata and cap describes also insert `calls` edges by SQL after indexing. The
 * unit describes (`stdCollision`, `swiftModuleName`, `isCandidateEdge`, the Cargo crate map)
 * build none. Where a fixture depends on how the resolver binds an edge, the expected
 * resolvedBy and confidence are noted inline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../../../src';
import { DatabaseConnection, getDatabasePath } from '../../../src/db';
import {
  candidateEdgeSql,
  findSuspects,
  findSuspectsInDb,
  formatSuspects,
  isCandidateEdge,
  stdCollision,
  suspectsToJson,
  type Suspect,
} from '../../../src/extensions/resolution/suspects';
import { getCargoWorkspaceCrateMap } from '../../../src/resolution/frameworks/cargo-workspace';
import { swiftModuleName } from '../../../src/resolution/swift-module';
import type { ResolutionContext } from '../../../src/resolution/types';

const RUST_APP_CARGO = '[package]\nname = "app"\nversion = "0.1.0"\n';
/** Root workspace: crates a and b are members, so each has a known crate. */
const RUST_AB_WORKSPACE = '[workspace]\nmembers = ["a", "b"]\n';

/** Writes `files` into a fresh temp dir, indexes it, closes the graph, and returns the dir. */
async function buildProject(files: Record<string, string>): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-suspects-'));
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), source);
  }
  const cg = await CodeGraph.init(dir, { index: true });
  cg.close();
  return dir;
}

function removeProject(dir: string | undefined): void {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

function byName(suspects: Suspect[], name: string): Suspect {
  const found = suspects.filter((s) => s.targetName === name);
  expect(found, `suspect targets named ${name}`).toHaveLength(1);
  return found[0]!;
}

describe('stdCollision', () => {
  it('flags a Rust standard-library method name', () => {
    expect(stdCollision('rust', 'push')).toBe(true);
    expect(stdCollision('rust', 'clear')).toBe(true);
  });

  it('does not flag a project-only Rust name', () => {
    expect(stdCollision('rust', 'render_all')).toBe(false);
  });

  it('is false for a language with no list', () => {
    expect(stdCollision('typescript', 'push')).toBe(false);
  });

  // The default predicate's Swift list is swift-builtins.ts's SWIFT_STD_METHODS.
  it('flags a Swift standard-library method name', () => {
    expect(stdCollision('swift', 'sorted')).toBe(true);
  });
});

describe('suspects: Swift std collision', () => {
  let dir: string;
  beforeAll(async () => {
    // `sorter` has no declared type; the resolver keeps the std-named `sorted()` on Sorter
    // only because the receiver's name shares a word with it (instance-method 0.8, below the
    // 0.9 declared bar, so a name-only candidate). A plain stdlib receiver (`[3, 1].sorted()`)
    // does not bind to Sorter at all, and a typed one (`let s = Sorter()`) binds at 0.9.
    dir = await buildProject({
      'Sources/App/Main.swift': 'import Util\n\nfunc run() {\n    let sorter = makeSorter()\n    let out = sorter.sorted()\n    print(out)\n}\n',
      'Sources/Util/Sorter.swift': 'public struct Sorter {\n    public func sorted() -> [Int] { return [] }\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('flags sorted as a std collision with an injected predicate, not low confidence, and no missing import', () => {
    const suspects = findSuspects(dir, { isStdMethod: (l, n) => l === 'swift' && n === 'sorted' });
    const sorted = byName(suspects, 'sorted');
    expect(sorted.language).toBe('swift');
    // App imports Util, so the cross-module edge is not a missing import; confidence 0.8 is
    // not below the low-confidence bar.
    expect(sorted.flags).toEqual(['std-collision']);
    expect(sorted.score).toBe(4);
    expect(sorted.definitions).toBe(1);
    expect(sorted.edgeCount).toBe(1);
    expect(sorted.edges).toHaveLength(1);
    expect(sorted.edges[0]).toMatchObject({
      callerName: 'run', refName: 'sorter.sorted', resolvedBy: 'instance-method', confidence: 0.8, flags: ['std-collision'],
    });
  });

  // The default predicate knows Swift's `sorted` (swift-builtins.ts's SWIFT_STD_METHODS).
  it('flags sorted as a std collision with the default predicate', () => {
    const sorted = byName(findSuspects(dir), 'sorted');
    expect(sorted.flags).toContain('std-collision');
  });
});

describe('suspects: Rust std collision', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await buildProject({
      'Cargo.toml': RUST_APP_CARGO,
      'src/main.rs': 'mod stack;\n\nfn run() {\n    let mut stack = build();\n    stack.push(1);\n    stack.clear();\n}\n',
      'src/stack.rs': 'pub struct Stack { items: Vec<i32> }\n\nimpl Stack {\n    pub fn push(&mut self, x: i32) { }\n    pub fn clear(&mut self) { }\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('flags push and clear as std collisions only (same crate, confidence 0.8)', () => {
    const suspects = findSuspects(dir);
    for (const name of ['push', 'clear']) {
      const s = byName(suspects, name);
      expect(s.flags, name).toEqual(['std-collision']);
      expect(s.score, name).toBe(4);
      expect(s.language, name).toBe('rust');
      expect(s.edges[0], name).toMatchObject({ callerName: 'run', resolvedBy: 'instance-method', confidence: 0.8 });
    }
  });
});

describe('suspects: Rust missing import', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await buildProject({
      'Cargo.toml': RUST_AB_WORKSPACE,
      'a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\n',
      'a/src/lib.rs': 'pub fn run() {\n    let widget = make();\n    widget.render_all();\n}\n',
      'b/Cargo.toml': '[package]\nname = "b"\nversion = "0.1.0"\n',
      'b/src/lib.rs': 'pub struct Widget;\nimpl Widget {\n    pub fn render_all(&self) {}\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('flags a call from crate a into crate b with no use of b as a missing import', () => {
    const s = byName(findSuspects(dir), 'render_all');
    expect(s.flags).toEqual(['missing-import']);
    expect(s.score).toBe(3);
    expect(s.edges[0]).toMatchObject({ callerName: 'run', resolvedBy: 'instance-method', confidence: 0.8 });
    expect(s.edges[0]!.flags).toEqual(['missing-import']);
  });
});

describe('suspects: Rust import present', () => {
  let dir: string;
  beforeAll(async () => {
    // The edge still forms (instance-method 0.8), and a/src/lib.rs has an import node named `b`.
    dir = await buildProject({
      'Cargo.toml': RUST_AB_WORKSPACE,
      'a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\n',
      'a/src/lib.rs': 'use b::Widget;\n\npub fn run() {\n    let widget = make();\n    widget.render_all();\n}\n',
      'b/Cargo.toml': '[package]\nname = "b"\nversion = "0.1.0"\n',
      'b/src/lib.rs': 'pub struct Widget;\nimpl Widget {\n    pub fn render_all(&self) {}\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('does not flag a missing import when the caller uses the target crate', () => {
    const s = byName(findSuspects(dir), 'render_all');
    expect(s.flags).not.toContain('missing-import');
    // Name-only alone still lists the edge, at score 0.
    expect(s.flags).toEqual([]);
    expect(s.score).toBe(0);
  });
});

/**
 * A kit layout: every crate lives in `<Kit>/rust/`, so a crate named by its directory
 * is `rust` on both sides. The crate name must come from the member's package name instead.
 */
function rustKitApp(appLib: string): Record<string, string> {
  return {
    'Cargo.toml': '[workspace]\nmembers = ["app/rust", "kit/rust"]\n',
    'app/rust/Cargo.toml': '[package]\nname = "my-app"\nversion = "0.1.0"\n',
    'app/rust/src/lib.rs': appLib,
    'kit/rust/Cargo.toml': '[package]\nname = "my-kit"\nversion = "0.1.0"\n',
    'kit/rust/src/lib.rs': 'pub struct Widget;\nimpl Widget {\n    pub fn render_all(&self) {}\n}\n',
  };
}

describe('suspects: Rust crates in same-named directories (package name, not directory)', () => {
  let withUse: string;
  let withoutUse: string;
  beforeAll(async () => {
    withUse = await buildProject(rustKitApp(
      'use my_kit::Widget;\n\npub fn run() {\n    let widget = make();\n    widget.render_all();\n}\n',
    ));
    withoutUse = await buildProject(rustKitApp(
      'pub fn run() {\n    let widget = make();\n    widget.render_all();\n}\n',
    ));
  });
  afterAll(() => {
    removeProject(withUse);
    removeProject(withoutUse);
  });

  it('does not flag a missing import when the caller uses the kit by its package name', () => {
    const s = byName(findSuspects(withUse), 'render_all');
    expect(s.edges[0]).toMatchObject({ callerName: 'run', callerFile: 'app/rust/src/lib.rs' });
    expect(s.flags).not.toContain('missing-import');
  });

  it('flags a missing import when the caller does not use the kit', () => {
    const s = byName(findSuspects(withoutUse), 'render_all');
    expect(s.edges[0]).toMatchObject({ callerName: 'run', callerFile: 'app/rust/src/lib.rs' });
    expect(s.flags).toContain('missing-import');
  });
});

describe('suspects: Rust crates with no root workspace (abstain)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await buildProject({
      'a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\n',
      'a/src/lib.rs': 'pub fn run() {\n    let widget = make();\n    widget.render_all();\n}\n',
      'b/Cargo.toml': '[package]\nname = "b"\nversion = "0.1.0"\n',
      'b/src/lib.rs': 'pub struct Widget;\nimpl Widget {\n    pub fn render_all(&self) {}\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('does not flag a missing import when neither crate is a workspace member', () => {
    const s = byName(findSuspects(dir), 'render_all');
    expect(s.edges[0]).toMatchObject({ callerName: 'run', resolvedBy: 'instance-method' });
    expect(s.flags).not.toContain('missing-import');
  });
});

describe('suspects: Swift missing import + several definitions', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await buildProject({
      'Sources/App/Main.swift': 'import Foundation\n\nfunc run() {\n    let x = makeWidget()\n    print(x)\n}\n',
      'Sources/Util/Widget.swift': 'public func makeWidget() -> Int { return 1 }\n',
      'Sources/Other/Widget2.swift': 'public func makeWidget() -> Int { return 2 }\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('flags makeWidget as missing-import, several-definitions and low-confidence', () => {
    const s = byName(findSuspects(dir), 'makeWidget');
    expect(s.flags).toEqual(['missing-import', 'several-definitions', 'low-confidence']);
    expect(s.definitions).toBe(2);
    expect(s.score).toBe(6);
    expect(s.edges[0]).toMatchObject({
      callerName: 'run', refName: 'makeWidget', resolvedBy: 'exact-match', confidence: 0.4,
    });
  });
});

describe('swiftModuleName', () => {
  // SwiftPM's c99name (`spm_mangledToC99ExtendedIdentifier`, swift-tools-support-core
  // StringMangling.swift @ c574915f): every Unicode scalar outside its C99 Annex D allowed
  // range table becomes `_`, and a first scalar that is a digit is replaced by `_` (not
  // prefixed; '1abc' -> '_abc' measured with Swift 6.4).
  it('replaces a hyphen with an underscore', () => {
    expect(swiftModuleName('mcp-benchmarker')).toBe('mcp_benchmarker');
  });

  it('replaces a dot and a space with underscores', () => {
    expect(swiftModuleName('a.b c')).toBe('a_b_c');
  });

  it('replaces a leading digit with an underscore', () => {
    expect(swiftModuleName('1abc')).toBe('_abc');
  });

  it('keeps a non-ASCII letter and replaces a plus sign', () => {
    expect(swiftModuleName('na\u00efve+x')).toBe('na\u00efve_x');
  });

  it('leaves a plain identifier unchanged', () => {
    expect(swiftModuleName('Util')).toBe('Util');
  });

  it('replaces a character outside the table (a fraction, U+00BD) with an underscore', () => {
    expect(swiftModuleName('a½b')).toBe('a_b');
  });

  it('keeps a Roman numeral (U+2163, in the table range U+2160-U+2182)', () => {
    expect(swiftModuleName('aⅣb')).toBe('aⅣb');
  });

  it('replaces a combining mark outside the table (U+0308) with an underscore', () => {
    // 'i' + COMBINING DIAERESIS: the table allows precomposed U+00EF but not U+0308.
    expect(swiftModuleName('naïve')).toBe('nai_ve');
  });
});

describe('suspects: Swift import of a hyphenated target names its c99name', () => {
  // The target sits in Sources/mcp-benchmarker, so `import` must name mcp_benchmarker.
  // benchTargetRun has one definition, so both edges are name-only (exact-match) and differ
  // only in whether the caller imports the target's module.
  let dir: string;
  beforeAll(async () => {
    dir = await buildProject({
      'Sources/mcp-benchmarker/Bench.swift': 'public func benchTargetRun() -> Int { return 1 }\n',
      'Sources/bench-cli/Main.swift':
        'import mcp_benchmarker\n\nfunc cliRun() {\n    let x = benchTargetRun()\n    print(x)\n}\n',
      'Sources/Other/Main.swift': 'import Foundation\n\nfunc otherRun() {\n    let x = benchTargetRun()\n    print(x)\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  function edgeFrom(callerName: string) {
    const s = byName(findSuspects(dir), 'benchTargetRun');
    const edges = s.edges.filter((e) => e.callerName === callerName);
    expect(edges, `edges from ${callerName}`).toHaveLength(1);
    return edges[0]!;
  }

  it('does not flag a missing import when the caller imports mcp_benchmarker', () => {
    const e = edgeFrom('cliRun');
    expect(e).toMatchObject({ callerFile: 'Sources/bench-cli/Main.swift', refName: 'benchTargetRun' });
    expect(e.flags).not.toContain('missing-import');
  });

  it('flags a missing import when the caller does not import the target', () => {
    const e = edgeFrom('otherRun');
    expect(e).toMatchObject({ callerFile: 'Sources/Other/Main.swift', refName: 'benchTargetRun' });
    expect(e.flags).toContain('missing-import');
  });
});

describe('suspects: Swift import of a target named with a Roman numeral keeps it', () => {
  // The target sits in Sources/aⅣb; U+2163 is in SwiftPM's allowed table, so the c99name
  // is the directory itself and `import aⅣb` names it. romanTargetRun has one definition,
  // so both edges are name-only (exact-match) and differ only in the caller's import.
  const MODULE = 'aⅣb';
  let dir: string;
  beforeAll(async () => {
    dir = await buildProject({
      [`Sources/${MODULE}/Roman.swift`]: 'public func romanTargetRun() -> Int { return 1 }\n',
      'Sources/RomanCli/Main.swift':
        `import ${MODULE}\n\nfunc romanCliRun() {\n    let x = romanTargetRun()\n    print(x)\n}\n`,
      'Sources/RomanOther/Main.swift':
        'import Foundation\n\nfunc romanOtherRun() {\n    let x = romanTargetRun()\n    print(x)\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  function edgeFrom(callerName: string) {
    const s = byName(findSuspects(dir), 'romanTargetRun');
    const edges = s.edges.filter((e) => e.callerName === callerName);
    expect(edges, `edges from ${callerName}`).toHaveLength(1);
    return edges[0]!;
  }

  it(`does not flag a missing import when the caller imports ${MODULE}`, () => {
    const e = edgeFrom('romanCliRun');
    expect(e).toMatchObject({ callerFile: 'Sources/RomanCli/Main.swift', refName: 'romanTargetRun' });
    expect(e.flags).not.toContain('missing-import');
  });

  it('flags a missing import when the caller does not import the target', () => {
    const e = edgeFrom('romanOtherRun');
    expect(e).toMatchObject({ callerFile: 'Sources/RomanOther/Main.swift', refName: 'romanTargetRun' });
    expect(e.flags).toContain('missing-import');
  });
});

describe('suspects: Rust several definitions', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await buildProject({
      'Cargo.toml': RUST_APP_CARGO,
      'src/main.rs': 'mod a;\nmod b;\n\nfn run() {\n    let thing = make();\n    thing.render_all();\n}\n',
      'src/a.rs': 'pub struct Thing;\nimpl Thing {\n    pub fn render_all(&self) {}\n}\n',
      'src/b.rs': 'pub struct Other;\nimpl Other {\n    pub fn render_all(&self) {}\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('flags render_all as several-definitions only, with definitions=2', () => {
    const s = byName(findSuspects(dir), 'render_all');
    expect(s.flags).toEqual(['several-definitions']);
    expect(s.definitions).toBe(2);
    expect(s.score).toBe(2);
    expect(s.targetQualifiedName).toBe('Thing::render_all');
  });
});

describe('suspects: non-suspect controls', () => {
  let dir: string;
  beforeAll(async () => {
    // Rust: g.spin_up() on a typed parameter resolves instance-method 0.9.
    // TypeScript: assemble() resolves through its import (resolvedBy 'import', 0.9).
    dir = await buildProject({
      'Cargo.toml': RUST_APP_CARGO,
      'src/main.rs': 'mod gadget;\nuse crate::gadget::Gadget;\n\nfn run(g: &Gadget) {\n    g.spin_up();\n}\n',
      'src/gadget.rs': 'pub struct Gadget;\nimpl Gadget {\n    pub fn spin_up(&self) {}\n}\n',
      'web/run.ts': "import { assemble } from './gadget';\n\nexport function run() {\n  assemble();\n}\n",
      'web/gadget.ts': 'export function assemble() {}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('lists neither a typed receiver call nor an import-resolved call', () => {
    const suspects = findSuspects(dir);
    expect(suspects.map((s) => s.targetName)).not.toContain('spin_up');
    expect(suspects.map((s) => s.targetName)).not.toContain('assemble');
    expect(suspects).toEqual([]);
  });
});

describe('suspects: ranking, options, JSON and text', () => {
  let dir: string;
  beforeAll(async () => {
    // Edges: run→Stack::push (line 7), run→Stack::clear (line 8), run→Thing::render_all (line 10),
    // run2→Stack::push (line 15); all instance-method 0.8. push and clear score 4 (std), render_all 2.
    dir = await buildProject({
      'Cargo.toml': RUST_APP_CARGO,
      'src/main.rs':
        'mod stack;\nmod a;\nmod b;\n\nfn run() {\n    let mut stack = build();\n    stack.push(1);\n    stack.clear();\n' +
        '    let thing = make();\n    thing.render_all();\n}\n\nfn run2() {\n    let mut stack = build();\n    stack.push(2);\n}\n',
      'src/stack.rs': 'pub struct Stack { items: Vec<i32> }\n\nimpl Stack {\n    pub fn push(&mut self, x: i32) { }\n    pub fn clear(&mut self) { }\n}\n',
      'src/a.rs': 'pub struct Thing;\nimpl Thing {\n    pub fn render_all(&self) {}\n}\n',
      'src/b.rs': 'pub struct Other;\nimpl Other {\n    pub fn render_all(&self) {}\n}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('ranks std targets above a several-definitions target, and equal scores by edge count', () => {
    const suspects = findSuspects(dir);
    expect(suspects.map((s) => s.targetName)).toEqual(['push', 'clear', 'render_all']);
    expect(suspects.map((s) => s.score)).toEqual([4, 4, 2]);
    expect(suspects.map((s) => s.edgeCount)).toEqual([2, 1, 1]);
  });

  it('orders a target\'s edges by callerFile then line when scores tie', () => {
    const push = byName(findSuspects(dir), 'push');
    expect(push.edges.map((e) => [e.callerName, e.callerFile, e.line])).toEqual([
      ['run', 'src/main.rs', 7],
      ['run2', 'src/main.rs', 15],
    ]);
  });

  it('honours limit and maxEdgesPerTarget', () => {
    const limited = findSuspects(dir, { limit: 1 });
    expect(limited.map((s) => s.targetName)).toEqual(['push']);
    const capped = byName(findSuspects(dir, { maxEdgesPerTarget: 1 }), 'push');
    expect(capped.edgeCount).toBe(2);
    expect(capped.edges).toHaveLength(1);
  });

  // The candidate query is read with iterate() rather than all(); the proxy records which one the
  // report calls.
  it('streams the candidate rows instead of reading them all at once', () => {
    const conn = DatabaseConnection.open(getDatabasePath(dir), { readOnly: true });
    try {
      const db = conn.getDb();
      const reads: string[] = [];
      // The candidate query is the one statement that reads every candidate edge (`FROM edges e`).
      const watched = new Proxy(db, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop !== 'prepare') return typeof value === 'function' ? value.bind(target) : value;
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!/FROM edges e\b/.test(sql)) return stmt;
            return {
              ...stmt,
              all: (...params: unknown[]) => { reads.push('all'); return stmt.all(...params); },
              iterate: (...params: unknown[]) => { reads.push('iterate'); return stmt.iterate(...params); },
            };
          };
        },
      });
      const push = byName(findSuspectsInDb(watched, dir, { maxEdgesPerTarget: 1 }), 'push');
      expect(reads).toEqual(['iterate']);
      expect(push.edgeCount).toBe(2);
      expect(push.edges.map((e) => [e.callerName, e.line])).toEqual([['run', 7]]);
    } finally {
      conn.close();
    }
  });

  it('serialises to version-1 JSON with exactly the Suspect and SuspectEdge keys', () => {
    const json = suspectsToJson(findSuspects(dir));
    const round = JSON.parse(JSON.stringify(json));
    expect(round).toEqual(json);
    expect(round.version).toBe(1);
    expect(round.suspects).toHaveLength(3);
    const suspectKeys = [
      'definitions', 'edgeCount', 'edges', 'flags', 'language', 'score', 'targetFile', 'targetId',
      'targetKind', 'targetLine', 'targetName', 'targetQualifiedName',
    ];
    const edgeKeys = ['callerFile', 'callerId', 'callerName', 'confidence', 'flags', 'line', 'refName', 'resolvedBy'];
    for (const s of round.suspects) {
      expect(Object.keys(s).sort()).toEqual(suspectKeys);
      for (const e of s.edges) expect(Object.keys(e).sort()).toEqual(edgeKeys);
    }
  });

  it('formats a header, rank lines and indented edge lines', () => {
    const lines = formatSuspects(findSuspects(dir)).split('\n');
    expect(lines[0]).toBe('3 suspect targets (4 call edges)');
    expect(lines).toContain('1. [score 4] Stack::push  src/stack.rs:4  2 call(s)  std-collision  defs=1');
    expect(lines).toContain('    run  src/main.rs:7  stack.push  instance-method 0.8');
    expect(lines).toContain('    run2  src/main.rs:15  stack.push  instance-method 0.8');
    expect(lines.some((l) => l.startsWith('3. [score 2] Thing::render_all ') && l.endsWith('several-definitions  defs=2')))
      .toBe(true);
  });

  it('formats an empty list', () => {
    expect(formatSuspects([])).toBe('No suspect call edges.');
  });
});

interface CallEdgeRow {
  kind: string;
  metadata: string | null;
  srcFile: string | null;
  tgtFile: string | null;
  candidate: number;
}

/**
 * The one `calls` edge from the node named `caller` to the node named `target`, read from the
 * index read-only, with `candidateEdgeSql('edges')` evaluated on that row.
 */
function callEdge(dir: string, caller: string, target: string): CallEdgeRow {
  const conn = DatabaseConnection.open(getDatabasePath(dir), { readOnly: true });
  try {
    const rows = conn.getDb().prepare(
      `SELECT edges.kind AS kind, edges.metadata AS metadata,
              (SELECT file_path FROM nodes WHERE id = edges.source) AS srcFile,
              (SELECT file_path FROM nodes WHERE id = edges.target) AS tgtFile,
              ${candidateEdgeSql('edges')} AS candidate
         FROM edges
        WHERE edges.kind = 'calls'
          AND edges.source IN (SELECT id FROM nodes WHERE name = ?)
          AND edges.target IN (SELECT id FROM nodes WHERE name = ?)`,
    ).all(caller, target) as CallEdgeRow[];
    expect(rows, `calls edges ${caller} -> ${target}`).toHaveLength(1);
    return rows[0]!;
  } finally {
    conn.close();
  }
}

describe('suspects: a same-file exact-match call is certain, a cross-file one is a candidate', () => {
  let dir: string;
  beforeAll(async () => {
    // a.ts: a() calls b(), defined in the same file: exact-match, same file, so certain.
    // caller.ts: run() calls helper(), defined in helper.ts and NOT imported, so the resolver
    // binds it by name alone (exact-match) across files: still a candidate.
    dir = await buildProject({
      'a.ts': 'export function a() { b() }\nfunction b() {}\n',
      'caller.ts': 'export function run() {\n  helper();\n}\n',
      'helper.ts': 'export function helper() {}\n',
    });
  });
  afterAll(() => removeProject(dir));

  it('does not list the same-file exact-match target', () => {
    const edge = callEdge(dir, 'a', 'b');
    const metadata = JSON.parse(edge.metadata ?? 'null') as Record<string, unknown> | null;
    expect(metadata?.resolvedBy).toBe('exact-match');
    expect(edge.srcFile).toBe('a.ts');
    expect(edge.tgtFile).toBe('a.ts');
    expect(findSuspects(dir).map((s) => s.targetName)).not.toContain('b');
    expect(isCandidateEdge(edge.kind, metadata, edge.srcFile, edge.tgtFile)).toBe(false);
    expect(edge.candidate).toBe(0);
  });

  it('lists the cross-file exact-match target', () => {
    const edge = callEdge(dir, 'run', 'helper');
    const metadata = JSON.parse(edge.metadata ?? 'null') as Record<string, unknown> | null;
    expect(metadata?.resolvedBy).toBe('exact-match');
    expect(edge.srcFile).toBe('caller.ts');
    expect(edge.tgtFile).toBe('helper.ts');
    expect(findSuspects(dir).map((s) => s.targetName)).toContain('helper');
    expect(isCandidateEdge(edge.kind, metadata, edge.srcFile, edge.tgtFile)).toBe(true);
    expect(edge.candidate).toBe(1);
  });
});

/** One `calls` edge to insert by SQL: from the function or method named `caller` to the one named `target`. */
interface InsertedCall {
  caller: string;
  target: string;
  line: number;
  /** The stored metadata text, verbatim (it may be deliberately not JSON). */
  metadata: string;
}

/** A `calls` edge whose metadata is `metadata` as JSON. */
function call(caller: string, target: string, line: number, metadata: Record<string, unknown>): InsertedCall {
  return { caller, target, line, metadata: JSON.stringify(metadata) };
}

/** Inserts `calls` edges straight into the index at `dir` (writable), bypassing the extractor and resolver, so a test sets each edge's metadata exactly. */
function insertCalls(dir: string, calls: InsertedCall[]): void {
  const conn = DatabaseConnection.open(getDatabasePath(dir));
  try {
    const db = conn.getDb();
    const idOf = db.prepare(`SELECT id FROM nodes WHERE name = ? AND kind IN ('function', 'method')`);
    const insert = db.prepare(`INSERT INTO edges(source, target, kind, metadata, line) VALUES (?, ?, 'calls', ?, ?)`);
    for (const c of calls) {
      const source = (idOf.get(c.caller) as { id: string }).id;
      const target = (idOf.get(c.target) as { id: string }).id;
      insert.run(source, target, c.metadata, c.line);
    }
  } finally {
    conn.close();
  }
}

/** Removes the `calls` edges inserted at `line`, so one case's row does not leak into the next. */
function removeCallsAtLine(dir: string, line: number): void {
  const conn = DatabaseConnection.open(getDatabasePath(dir));
  try {
    conn.getDb().prepare(`DELETE FROM edges WHERE kind = 'calls' AND line = ?`).run(line);
  } finally {
    conn.close();
  }
}

/** `candidateEdgeSql('edges')` evaluated on the one edge at `line`, read from the index read-only; undefined when there is no such row. */
function candidateAtLine(dir: string, line: number): number | undefined {
  const conn = DatabaseConnection.open(getDatabasePath(dir), { readOnly: true });
  try {
    const row = conn.getDb()
      .prepare(`SELECT ${candidateEdgeSql('edges')} AS candidate FROM edges WHERE line = ?`)
      .get(line) as { candidate: number } | undefined;
    return row?.candidate;
  } finally {
    conn.close();
  }
}

/** A report with each target's listed edges emptied, so two reports can be compared on everything else. */
function withoutEdges(suspects: Suspect[]): Suspect[] {
  return suspects.map((s) => ({ ...s, edges: [] }));
}

describe('suspects: an edge whose stored metadata is not valid JSON', () => {
  let dir: string;
  beforeAll(async () => {
    // caller.ts run() calls helper() in helper.ts (cross-file exact-match): the one valid candidate.
    dir = await buildProject({
      'caller.ts': 'export function run() {\n  helper();\n}\n',
      'helper.ts': 'export function helper() {}\n',
    });
  });
  afterAll(() => removeProject(dir));

  // Metadata that is not JSON reads as absent when an edge is read, so the report must skip such a
  // row rather than throw. The writers store only JSON.stringify output, so these rows are inserted
  // directly. json_extract throws 'malformed JSON' on them; the candidate SQL reads each key inside
  // a CASE that tests json_valid first, so it never hands bad text to json_extract.
  it.each([[90, 'broken json {{{'], [91, '']])(
    'is skipped and the valid candidates are still listed (line %i, metadata %j)',
    (line, metadata) => {
      insertCalls(dir, [{ caller: 'run', target: 'helper', line, metadata }]);
      try {
        let suspects: Suspect[] = [];
        expect(() => { suspects = findSuspects(dir); }).not.toThrow();
        expect(suspects.map((s) => s.targetName)).toEqual(['helper']);
        expect(suspects[0]!.edgeCount).toBe(1);
        expect(suspects[0]!.edges.map((e) => e.line)).not.toContain(line);

        let candidate: number | undefined;
        expect(() => { candidate = candidateAtLine(dir, line); }).not.toThrow();
        expect(candidate).toBe(0);
      } finally {
        removeCallsAtLine(dir, line);
      }
    },
  );
});

describe('suspects: the per-target edge cap keeps the best edges', () => {
  // render_all (Rust, one definition, in crate b) receives 8 candidate edges, so the default cap of 5
  // would already cut it. Its highest-score edge, `run` (crate a calls crate b with no `use`:
  // missing-import, score 3), is inserted LAST, so a cap that keeps the first rows it reads lists
  // the wrong edges. `push` (std-collision, score 4) outranks render_all, so `limit` has ranking to do.
  // Every other edge of render_all is name-only: instance-method at 0.85 or 0.7, fuzzy at 0.5 or 0.6 or
  // with no confidence (read as 1), or exact-match (no confidence). The low-confidence flag sits only on
  // the three edges at 0.5, 0.6 and 0.7 (score 1), all unlisted at cap 1.
  let dir: string;
  let reference: Suspect[];
  beforeAll(async () => {
    dir = await buildProject({
      'Cargo.toml': '[workspace]\nmembers = ["a", "b"]\n',
      'a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\n',
      'a/src/lib.rs': 'pub fn run() {}\n',
      'b/Cargo.toml': '[package]\nname = "b"\nversion = "0.1.0"\n',
      'b/src/lib.rs':
        'mod other;\n\npub struct Widget;\n\nimpl Widget {\n    pub fn render_all(&self) {}\n    pub fn push(&mut self) {}\n}\n\n' +
        'pub fn local1() {}\npub fn local2() {}\npub fn local3() {}\npub fn local4() {}\npub fn local5() {}\n',
      'b/src/other.rs': 'pub fn other1() {}\npub fn other2() {}\npub fn other3() {}\n',
    });
    insertCalls(dir, [
      call('local1', 'render_all', 20, { resolvedBy: 'instance-method', confidence: 0.85, refName: 'widget.render_all' }),
      call('local2', 'render_all', 21, { resolvedBy: 'fuzzy', confidence: 0.5, refName: 'render_all' }),
      call('other1', 'render_all', 4, { resolvedBy: 'exact-match', refName: 'render_all' }),
      call('other2', 'render_all', 8, { resolvedBy: 'instance-method', confidence: 0.7, refName: 'widget.render_all' }),
      call('local3', 'render_all', 22, { resolvedBy: 'instance-method', confidence: 0.85, refName: 'widget.render_all' }),
      call('other3', 'render_all', 12, { resolvedBy: 'fuzzy', refName: 'render_all' }),
      call('local4', 'render_all', 23, { resolvedBy: 'fuzzy', confidence: 0.6, refName: 'render_all' }),
      call('local5', 'push', 24, { resolvedBy: 'instance-method', confidence: 0.85, refName: 'widget.push' }),
      call('other1', 'push', 9, { resolvedBy: 'instance-method', confidence: 0.85, refName: 'widget.push' }),
      call('run', 'render_all', 3, { resolvedBy: 'instance-method', confidence: 0.85, refName: 'widget.render_all' }),
    ]);
    reference = findSuspects(dir, { maxEdgesPerTarget: 1000 });
  });
  afterAll(() => removeProject(dir));

  // Fixture check: the cap cases below only mean something if render_all has more than the default
  // cap of candidate edges and its top-ranked edge is the one inserted last.
  it('gives render_all at least 7 candidate edges, with the last-inserted edge ranked first', () => {
    const target = byName(reference, 'render_all');
    expect(target.edgeCount).toBeGreaterThanOrEqual(7);
    expect(target.score).toBe(3);
    expect(target.edges[0]).toMatchObject({ callerName: 'run', resolvedBy: 'instance-method' });
    expect(target.edges[0]!.flags).toEqual(['missing-import']);
  });

  // The cap only trims the listed edges. Every other field of every target matches the uncapped report,
  // and the listed edges are the first k of the uncapped order.
  it.each([0, 1, 2, 3])('lists the first %i edges in rank order, and every other field matches the uncapped report', (k) => {
    const capped = findSuspects(dir, { maxEdgesPerTarget: k });
    expect(withoutEdges(capped)).toEqual(withoutEdges(reference));
    expect(capped.map((s) => s.edges)).toEqual(reference.map((s) => s.edges.slice(0, k)));
  });

  // Math.max(0, NaN) is NaN and slice(0, NaN) is empty: a NaN cap must list no edges, not all of them.
  it('treats a NaN cap as zero listed edges, keeping counts, flags and score', () => {
    const capped = findSuspects(dir, { maxEdgesPerTarget: Number.NaN });
    expect(withoutEdges(capped)).toEqual(withoutEdges(reference));
    expect(capped.map((s) => s.edges)).toEqual(reference.map(() => []));
  });

  // A negative cap clamps to zero: no edges listed, the rest of the report unchanged.
  it('treats a negative cap as zero listed edges', () => {
    const capped = findSuspects(dir, { maxEdgesPerTarget: -1 });
    expect(withoutEdges(capped)).toEqual(withoutEdges(reference));
    expect(capped.map((s) => s.edges)).toEqual(reference.map(() => []));
  });

  // Targets rank by score before limit applies: push (4) above render_all (3). render_all's first edge
  // is inserted before push's, so a limit taken in insertion order would keep render_all instead.
  it('limit keeps the top-ranked targets, not the first-inserted ones', () => {
    const limited = findSuspects(dir, { limit: 1 });
    expect(limited.map((s) => s.targetName)).toEqual(['push']);
    expect(withoutEdges(limited)).toEqual(withoutEdges(reference.slice(0, 1)));
    expect(limited[0]!.edges).toEqual(reference[0]!.edges);
  });

  // At cap 1 only `run` is listed, yet low-confidence is carried by three edges that are not. The target's
  // flags are the union over all its edges, so the flag must survive the cap.
  it('keeps a flag that only an unlisted edge carries on the target at cap 1', () => {
    const capped = byName(findSuspects(dir, { maxEdgesPerTarget: 1 }), 'render_all');
    expect(capped.edges.map((e) => e.callerName)).toEqual(['run']);
    expect(capped.edges[0]!.flags).toEqual(['missing-import']);
    expect(capped.flags).toContain('low-confidence');
    expect(capped.flags).toEqual(['missing-import', 'low-confidence']);
  });
});

describe('isCandidateEdge', () => {
  it('flags a fuzzy edge even within one file', () => {
    expect(isCandidateEdge('calls', { resolvedBy: 'fuzzy' }, 'a.ts', 'a.ts')).toBe(true);
  });

  it('flags an instance-method edge below 0.9 and not one at 0.95', () => {
    expect(isCandidateEdge('calls', { resolvedBy: 'instance-method', confidence: 0.85 }, 'a.rs', 'b.rs')).toBe(true);
    expect(isCandidateEdge('calls', { resolvedBy: 'instance-method', confidence: 0.95 }, 'a.rs', 'b.rs')).toBe(false);
  });

  it('reads a boolean confidence as 1 or 0 and a missing or string one as 1', () => {
    expect(isCandidateEdge('calls', { resolvedBy: 'instance-method', confidence: false }, 'a.rs', 'b.rs')).toBe(true);
    expect(isCandidateEdge('calls', { resolvedBy: 'instance-method', confidence: true }, 'a.rs', 'b.rs')).toBe(false);
    expect(isCandidateEdge('calls', { resolvedBy: 'instance-method' }, 'a.rs', 'b.rs')).toBe(false);
    expect(isCandidateEdge('calls', { resolvedBy: 'instance-method', confidence: '0.5' }, 'a.rs', 'b.rs')).toBe(false);
  });

  it('never flags a non-calls edge or an edge with no resolvedBy', () => {
    expect(isCandidateEdge('references', { resolvedBy: 'fuzzy' }, 'a.ts', 'b.ts')).toBe(false);
    expect(isCandidateEdge('calls', {}, 'a.ts', 'b.ts')).toBe(false);
    expect(isCandidateEdge('calls', null, 'a.ts', 'b.ts')).toBe(false);
    expect(isCandidateEdge('calls', { resolvedBy: 'import' }, 'a.ts', 'b.ts')).toBe(false);
  });

  it('flags an exact-match edge whose files are unknown, and not one within one file', () => {
    expect(isCandidateEdge('calls', { resolvedBy: 'exact-match' }, null, null)).toBe(true);
    expect(isCandidateEdge('calls', { resolvedBy: 'exact-match' }, 'a.ts', undefined)).toBe(true);
    expect(isCandidateEdge('calls', { resolvedBy: 'exact-match' }, 'a.ts', 'b.ts')).toBe(true);
    expect(isCandidateEdge('calls', { resolvedBy: 'exact-match' }, 'a.ts', 'a.ts')).toBe(false);
  });
});

describe('getCargoWorkspaceCrateMap with the partial context the suspects extension passes', () => {
  // cargoMembers passes a context with only readFile and listDirectories (no getCargoCrates), so the
  // helper must read the manifests itself. A context that does carry getCargoCrates answers with that map.
  const manifests: Record<string, string> = {
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
    'crates/a-b/Cargo.toml': '[package]\nname = "a-b"\nversion = "0.1.0"\n',
  };
  const directories: Record<string, string[]> = { crates: ['a-b'] };
  const partial = {
    readFile: (relPath: string): string | null => manifests[relPath] ?? null,
    listDirectories: (relPath: string): string[] => directories[relPath] ?? [],
  } as unknown as ResolutionContext;

  it('reads the member manifests when the context has no getCargoCrates', () => {
    expect(getCargoWorkspaceCrateMap(partial)).toEqual(
      new Map([['a-b', 'crates/a-b'], ['a_b', 'crates/a-b']]),
    );
  });

  it('returns the map a context carries in getCargoCrates', () => {
    const carried = new Map([['carried', 'crates/carried']]);
    const withCrates = { ...partial, getCargoCrates: () => carried } as unknown as ResolutionContext;
    expect(getCargoWorkspaceCrateMap(withCrates)).toBe(carried);
  });
});
