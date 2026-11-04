/**
 * Rust `impl Trait for Type`: the impl's target and the impl method's owner,
 * at extraction level, for both walkers (review fixes R1-04, R1-05, R2-17,
 * R2-18).
 *
 * Each single-file fixture is extracted by the TypeScript walker and by the
 * native kernel walker, and each walker must:
 *   - name the same type as carrying the `implements` reference (the impl's target),
 *   - name the same type as the `contains` owner of the impl's method,
 *   - return the same canonicalized ExtractionResult as the other walker.
 *
 * The TypeScript describe never skips. The kernel describe skips when no kernel
 * binary is staged, and asserts that tryKernelExtract returns a result, so a
 * kernel load failure fails the test rather than silently falling back to the
 * TypeScript walker.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node',
);
const kernelBuilt = fs.existsSync(KERNEL_PATH);

const lines = (...l: string[]): string => [...l, ''].join('\n');

/** A single file: `pub trait T` followed by `body`, as the feature suite's crate. */
function crateFile(...body: string[]): string {
  return lines('pub trait T {', '    fn run(&self);', '}', '', ...body);
}

/**
 * `n` same-file bindings `use m::X as A1;`, `pub use A1 as A2;`, ... ending at `An`
 * (alternating `use` and `pub use`): naming `An` takes exactly `n` use rewrites to reach `m::X`.
 */
function useChain(n: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    `${i % 2 ? 'pub use' : 'use'} ${i === 0 ? 'm::X' : `A${i}`} as A${i + 1};`);
}

/** 1-based line of the one line of `source` that reads exactly `text`. */
function lineOf(source: string, text: string): number {
  const hits = source.split('\n').flatMap((l, i) => (l === text ? [i + 1] : []));
  if (hits.length !== 1) throw new Error(`fixture line ${JSON.stringify(text)} occurs ${hits.length} times`);
  return hits[0]!;
}

interface Expected {
  /** `qualifiedName@line implements TraitText`, one per `implements` reference. */
  implementers: string[];
  /** `qualifiedName@line contains method@line`, one per `contains` edge to an impl method. */
  owners: string[];
}

interface Fixture {
  name: string;
  file: string;
  source: string;
  expected: (at: (text: string) => number) => Expected;
}

function fixture(
  name: string,
  file: string,
  source: string,
  expected: (at: (text: string) => number) => Expected,
): Fixture {
  return { name, file, source, expected };
}

const FIXTURES: Fixture[] = [
  // R1-04: the impl's type is the fn-local shadow, and it owns the impl's method.
  fixture('R1-04 a fn-local type shadows a module-level namesake', '/proj/src/lib.rs',
    crateFile('pub struct Local;', '', 'pub fn host() {', '    struct Local;', '    impl T for Local {', '        fn run(&self) {}', '    }', '}'),
    (at) => ({
      implementers: [`host::Local@${at('    struct Local;')} implements T`],
      owners: [`host::Local@${at('    struct Local;')} contains run@${at('        fn run(&self) {}')}`],
    })),

  // R1-04: an earlier fn's namesake, then a later fn's impl for the module-level type.
  fixture("R1-04 an impl in a later fn for a module-level type is not owned by an earlier fn's namesake", '/proj/src/lib.rs',
    crateFile('pub fn early() {', '    struct Other;', '}', '', 'pub struct Other;', '', 'pub fn later() {', '    impl T for Other {', '        fn run(&self) {}', '    }', '}'),
    (at) => ({
      implementers: [`Other@${at('pub struct Other;')} implements T`],
      owners: [`Other@${at('pub struct Other;')} contains run@${at('        fn run(&self) {}')}`],
    })),

  // R1-04: the same, with the impl at module level.
  fixture("R1-04 an earlier fn's namesake does not own a top-level impl's method", '/proj/src/lib.rs',
    crateFile('pub fn early() {', '    struct Other;', '}', '', 'pub struct Other;', '', 'impl T for Other {', '    fn run(&self) {}', '}'),
    (at) => ({
      implementers: [`Other@${at('pub struct Other;')} implements T`],
      owners: [`Other@${at('pub struct Other;')} contains run@${at('    fn run(&self) {}')}`],
    })),

  // R1-04: a type in a sibling block is out of scope at a later impl in the fn; the module-level X is named.
  fixture("R1-04 a block-scoped type is not the one a later impl in the fn names", '/proj/src/lib.rs',
    crateFile('pub struct X;', '', 'pub fn host() {', '    {', '        struct X;', '    }', '    impl T for X {', '        fn run(&self) {}', '    }', '}'),
    (at) => ({
      implementers: [`X@${at('pub struct X;')} implements T`],
      owners: [`X@${at('pub struct X;')} contains run@${at('        fn run(&self) {}')}`],
    })),

  // R1-05: `m::X` names the fn-local module's X, which owns the method; the module-level X does not.
  fixture('R1-05 a qualified target in a fn-local module owns its impl and methods', '/proj/src/lib.rs',
    crateFile('pub struct X;', '', 'pub fn host() {', '    mod m {', '        pub struct X;', '    }', '    impl T for m::X {', '        fn run(&self) {}', '    }', '}'),
    (at) => ({
      implementers: [`host::X@${at('        pub struct X;')} implements T`],
      owners: [`host::X@${at('        pub struct X;')} contains run@${at('        fn run(&self) {}')}`],
    })),

  // R1-05: two sibling fn-local modules with an X each; `b::X` takes only b's X.
  fixture('R1-05 qualified targets distinguish sibling fn-local modules', '/proj/src/lib.rs',
    crateFile('pub fn host() {', '    mod a { pub struct X; }', '    mod b { pub struct X; }', '    impl T for b::X {', '        fn run(&self) {}', '    }', '}'),
    (at) => ({
      implementers: [`host::X@${at('    mod b { pub struct X; }')} implements T`],
      owners: [`host::X@${at('    mod b { pub struct X; }')} contains run@${at('        fn run(&self) {}')}`],
    })),

  // R2-17: a same-file `use` brings the type into scope (guard).
  fixture('R2-17 an impl for a type named by a same-file use implements it', '/proj/src/lib.rs',
    crateFile('mod m { pub struct X; }', 'use m::X;', '', 'impl T for X {', '    fn run(&self) {}', '}'),
    (at) => ({
      implementers: [`X@${at('mod m { pub struct X; }')} implements T`],
      owners: [`X@${at('mod m { pub struct X; }')} contains run@${at('    fn run(&self) {}')}`],
    })),

  // R2-17: a `use ... as` alias names the aliased type; the grouped sibling gets nothing.
  fixture('R2-17 a use-as alias implements the aliased type; a grouped sibling implements nothing', '/proj/src/lib.rs',
    crateFile('mod n { pub struct Y; pub struct Z; }', 'use n::{Y as Renamed, Z};', '', 'impl T for Renamed {', '    fn run(&self) {}', '}'),
    (at) => ({
      implementers: [`Y@${at('mod n { pub struct Y; pub struct Z; }')} implements T`],
      owners: [`Y@${at('mod n { pub struct Y; pub struct Z; }')} contains run@${at('    fn run(&self) {}')}`],
    })),

  // R2-17: a `use` of a same-file `pub use` re-export names the re-exported type (guard).
  fixture('R2-17 a use of a same-file pub use re-export names the re-exported type', '/proj/src/lib.rs',
    crateFile('mod m { pub struct X; }', 'mod api { pub use crate::m::X; }', 'use api::X;', '', 'impl T for X {', '    fn run(&self) {}', '}'),
    (at) => ({
      implementers: [`X@${at('mod m { pub struct X; }')} implements T`],
      owners: [`X@${at('mod m { pub struct X; }')} contains run@${at('    fn run(&self) {}')}`],
    })),

  // R2-17: a leading `::` alias is an external crate, so it links nothing (guard).
  fixture('R2-17 a leading :: use alias to an external crate links no local type', '/proj/src/lib.rs',
    crateFile('mod remote { pub struct X; }', 'use ::remote::X as External;', '', 'impl T for External {', '    fn run(&self) {}', '}'),
    () => ({ implementers: [], owners: [] })),

  // R2-17: a leading `::` path is an external crate, so it names no local module type.
  fixture('R2-17 an absolute :: path to an external crate links no local module type', '/proj/src/lib.rs',
    crateFile('mod remote { pub struct X; }', '', 'impl T for ::remote::X {', '    fn run(&self) {}', '}'),
    () => ({ implementers: [], owners: [] })),

  // R2-17: a cycle of `pub use` re-exports ends, and names no type (guard).
  fixture('R2-17 a cycle of pub use re-exports terminates and names no type', '/proj/src/lib.rs',
    crateFile('mod a { pub use super::b::X; }', 'mod b { pub use super::a::X; }', 'use a::X;', '', 'impl T for X {', '    fn run(&self) {}', '}'),
    () => ({ implementers: [], owners: [] })),

  // R2-17: A8 -> A7 -> ... -> A1 -> m::X is 8 `use` rewrites, exactly MAX_USE_REWRITES (8), which
  // both walkers allow (TS `rewrites++ >= 8`, kernel `rewrites >= 8` before `+= 1`: the 9th is refused).
  fixture('R2-17 a same-file use chain needing exactly 8 rewrites names the type', '/proj/src/lib.rs',
    crateFile('mod m { pub struct X; }', ...useChain(8), '', 'impl T for A8 {', '    fn run(&self) {}', '}'),
    (at) => ({
      implementers: [`X@${at('mod m { pub struct X; }')} implements T`],
      owners: [`X@${at('mod m { pub struct X; }')} contains run@${at('    fn run(&self) {}')}`],
    })),

  // R2-17: the same chain one link longer (A9 ... -> m::X) needs 9 rewrites, past the limit, so it names nothing.
  fixture('R2-17 a same-file use chain needing 9 rewrites is past the limit and names no type', '/proj/src/lib.rs',
    crateFile('mod m { pub struct X; }', ...useChain(9), '', 'impl T for A9 {', '    fn run(&self) {}', '}'),
    () => ({ implementers: [], owners: [] })),

  // R2-18: `crate::m::X` in src/m.rs names that file's X.
  fixture('R2-18 a crate:: path in an out-of-line module file names the type that file defines', '/proj/src/m.rs',
    lines('pub struct X;', '', 'impl crate::T for crate::m::X {', '    fn run(&self) {}', '}'),
    (at) => ({
      implementers: [`X@${at('pub struct X;')} implements crate::T`],
      owners: [`X@${at('pub struct X;')} contains run@${at('    fn run(&self) {}')}`],
    })),

  // R2-18: `crate::elsewhere::W` beside a local W names nothing in this file.
  fixture('R2-18 a crate:: path to a module the crate lacks implements nothing beside a same-named type', '/proj/src/m.rs',
    lines('pub struct W;', '', 'impl crate::T for crate::elsewhere::W {', '    fn run(&self) {}', '}'),
    () => ({ implementers: [], owners: [] })),

  // R2-18: a nested out-of-line module path names the deepest file's type (guard).
  fixture('R2-18 a crate:: path through nested out-of-line modules names the deepest file', '/proj/src/a/b.rs',
    lines('pub struct Deep;', '', 'impl crate::T for crate::a::b::Deep {', '    fn run(&self) {}', '}'),
    (at) => ({
      implementers: [`Deep@${at('pub struct Deep;')} implements crate::T`],
      owners: [`Deep@${at('pub struct Deep;')} contains run@${at('    fn run(&self) {}')}`],
    })),

  // R2-18: a Cargo `[lib]` crate-root file (guessed as module `engine`) reads `crate::X` as written, since `X` does not start with that module path (guard).
  fixture('R2-18 a Cargo [lib] crate-root file reads crate::X as written', '/proj/src/engine.rs',
    crateFile('pub struct X;', '', 'impl T for crate::X {', '    fn run(&self) {}', '}'),
    (at) => ({
      implementers: [`X@${at('pub struct X;')} implements T`],
      owners: [`X@${at('pub struct X;')} contains run@${at('    fn run(&self) {}')}`],
    })),

  // R2-18: `crate::engine::X` reaches the inline `mod engine` in a [lib]-named file (guard).
  fixture('R2-18 a crate:: path through an inline mod named like the [lib] file reaches the type inside it', '/proj/src/engine.rs',
    crateFile('mod engine {', '    pub struct X;', '}', '', 'impl T for crate::engine::X {', '    fn run(&self) {}', '}'),
    (at) => ({
      implementers: [`X@${at('    pub struct X;')} implements T`],
      owners: [`X@${at('    pub struct X;')} contains run@${at('    fn run(&self) {}')}`],
    })),

  // R2-18: in src/m.rs, `crate::m::X` is the file's own top-level X, not the inline `mod m`'s X. Top-level X declared first.
  fixture('R2-18 a top-level X and an inline mod m holding its own X: crate::m::X names the top-level one (top first)', '/proj/src/m.rs',
    lines('pub struct X;', '', 'mod m {', '    pub struct X;', '}', '', 'impl crate::T for crate::m::X {', '    fn run(&self) {}', '}'),
    (at) => ({
      implementers: [`X@${at('pub struct X;')} implements crate::T`],
      owners: [`X@${at('pub struct X;')} contains run@${at('    fn run(&self) {}')}`],
    })),

  // R2-18: the same file with the inline `mod m` first: the path must not take the first X in the file.
  fixture('R2-18 a top-level X and an inline mod m holding its own X: crate::m::X names the top-level one (inline first)', '/proj/src/m.rs',
    lines('mod m {', '    pub struct X;', '}', '', 'pub struct X;', '', 'impl crate::T for crate::m::X {', '    fn run(&self) {}', '}'),
    (at) => ({
      implementers: [`X@${at('pub struct X;')} implements crate::T`],
      owners: [`X@${at('pub struct X;')} contains run@${at('    fn run(&self) {}')}`],
    })),

  // `self::` names the enclosing module and `super::` its parent: each reaches that module's items (guards).
  fixture('self:: names a type in the same inline module', '/proj/src/lib.rs',
    crateFile('mod inner {', '    use super::T;', '    pub struct X;', '    impl T for self::X {', '        fn run(&self) {}', '    }', '}'),
    (at) => ({
      implementers: [`X@${at('    pub struct X;')} implements T`],
      owners: [`X@${at('    pub struct X;')} contains run@${at('        fn run(&self) {}')}`],
    })),

  fixture('super:: names the outer type from an inline module', '/proj/src/lib.rs',
    crateFile('pub struct X;', '', 'mod inner {', '    impl super::T for super::X {', '        fn run(&self) {}', '    }', '}'),
    (at) => ({
      implementers: [`X@${at('pub struct X;')} implements super::T`],
      owners: [`X@${at('pub struct X;')} contains run@${at('        fn run(&self) {}')}`],
    })),

  // A path-qualified impl names the module-level type, never the fn-local namesake (guard).
  fixture('crate:: names the module-level type, not a fn-local namesake', '/proj/src/lib.rs',
    crateFile('pub struct Local;', '', 'pub fn host() {', '    struct Local;', '    impl T for crate::Local {', '        fn run(&self) {}', '    }', '}'),
    (at) => ({
      implementers: [`Local@${at('pub struct Local;')} implements T`],
      owners: [`Local@${at('pub struct Local;')} contains run@${at('        fn run(&self) {}')}`],
    })),
];

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;
let savedEnv: Record<string, string | undefined>;

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['rust']);
});

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  resetKernelForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetKernelForTests();
});

/** The TypeScript (wasm) walker, forced by the kill switch. */
function viaTs(file: string, source: string): ExtractionResult {
  process.env.CODEGRAPH_KERNEL = '0';
  try {
    return extractFromSource(file, source, 'rust');
  } finally {
    delete process.env.CODEGRAPH_KERNEL;
  }
}

/** The native kernel walker, routed for every language the kernel supports. Null when the kernel is unavailable, defers the file, or errors on it. */
function viaKernel(file: string, source: string): ExtractionResult | null {
  process.env.CODEGRAPH_KERNEL_LANGS = 'all';
  delete process.env.CODEGRAPH_KERNEL;
  return tryKernelExtract(file, source, 'rust');
}

function canon(result: ExtractionResult): { nodes: string[]; edges: string[]; refs: string[] } {
  return {
    nodes: result.nodes
      .map(({ updatedAt: _u, ...n }) => JSON.stringify(n, Object.keys(n).sort()))
      .sort(),
    edges: result.edges.map((e) => JSON.stringify(e, Object.keys(e).sort())).sort(),
    refs: result.unresolvedReferences
      .map((r) => JSON.stringify(r, Object.keys(r).sort()))
      .sort(),
  };
}

interface View {
  implementers: string[];
  owners: string[];
}

/** The node kinds an impl's methods can be owned by. */
const OWNER_KINDS: ReadonlySet<string> = new Set(['struct', 'union', 'enum', 'class']);

/**
 * The impl facts of one extraction, labelled by node so either walker reads the
 * same way: `qualifiedName@startLine` for a type, `name@startLine` for a method.
 */
function viewOf(result: ExtractionResult): View {
  const byId = new Map(result.nodes.map((n) => [n.id, n] as const));
  const label = (id: string): string => {
    const n = byId.get(id);
    return n ? `${n.qualifiedName}@${n.startLine}` : `<no node ${id}>`;
  };
  const implementers = result.unresolvedReferences
    .filter((r) => r.referenceKind === 'implements')
    .map((r) => `${label(r.fromNodeId)} implements ${r.referenceName}`)
    .sort();
  // Every method is also contained by its enclosing scope (the file, or the fn it sits in), and a
  // trait contains its own methods; only a type-shaped source is the impl method's owner.
  const owners = result.edges
    .filter((e) => e.kind === 'contains' && byId.get(e.target)?.kind === 'method' && OWNER_KINDS.has(byId.get(e.source)?.kind ?? ''))
    .map((e) => {
      const m = byId.get(e.target)!;
      return `${label(e.source)} contains ${m.name}@${m.startLine}`;
    })
    .sort();
  return { implementers, owners };
}

describe('TypeScript walker: Rust impl target and method owner', () => {
  for (const fx of FIXTURES) {
    it(fx.name, () => {
      const result = viaTs(fx.file, fx.source);
      const want = fx.expected((line) => lineOf(fx.source, line));
      const view = viewOf(result);
      expect(view.implementers, 'implements (impl target)').toEqual(want.implementers);
      expect(view.owners, 'contains (method owner)').toEqual(want.owners);
    });
  }
});

describe.skipIf(!kernelBuilt)('kernel walker: Rust impl target and method owner', () => {
  for (const fx of FIXTURES) {
    it(fx.name, () => {
      const kernel = viaKernel(fx.file, fx.source);
      expect(kernel, `kernel extraction failed for ${fx.file}`).not.toBeNull();
      const want = fx.expected((line) => lineOf(fx.source, line));
      const view = viewOf(kernel!);
      expect(view.implementers, 'implements (impl target)').toEqual(want.implementers);
      expect(view.owners, 'contains (method owner)').toEqual(want.owners);
      expect(canon(kernel!), 'kernel vs TypeScript canonical result').toEqual(canon(viaTs(fx.file, fx.source)));
    });
  }
});
