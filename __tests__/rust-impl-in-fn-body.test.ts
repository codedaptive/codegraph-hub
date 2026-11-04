/**
 * A Rust `impl Trait for Type` written inside a function body — a local type
 * implementing a trait for one test or one helper — implements the trait as a
 * top-level impl does: the type gets its `implements` edge and the trait's
 * methods reach the impl's.
 *
 * The body walker records the impl's trait as well as the local struct and
 * the impl's methods; without that trait reference the type has no
 * `implements` edge and the trait's methods look unused.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-rust-impl-in-fn-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

function nodeOf(cg: CodeGraph, kind: 'struct' | 'method', qualifiedName: string): Node {
  const node = cg.getNodesByKind(kind).find((n) => n.qualifiedName === qualifiedName);
  if (!node) throw new Error(`no ${kind} ${qualifiedName}`);
  return node;
}

/** The `qualifiedName`s a node has an outgoing `kind` edge to, sorted. */
function targetsOf(cg: CodeGraph, node: Node, kind: string): (string | undefined)[] {
  return cg
    .getOutgoingEdges(node.id)
    .filter((e) => e.kind === kind)
    .map((e) => cg.getNode(e.target)?.qualifiedName)
    .sort();
}

/** The traits a struct `implements`, as `qualifiedName`. */
function implemented(cg: CodeGraph, struct: string): (string | undefined)[] {
  return targetsOf(cg, nodeOf(cg, 'struct', struct), 'implements');
}

/** What a trait method's outgoing edges reach, as `qualifiedName`. */
function reached(cg: CodeGraph, method: string): (string | undefined)[] {
  return cg
    .getOutgoingEdges(nodeOf(cg, 'method', method).id)
    .map((e) => cg.getNode(e.target)?.qualifiedName)
    .sort();
}

/** The members a struct `contains`, as `qualifiedName`. */
function contained(cg: CodeGraph, struct: string): (string | undefined)[] {
  return targetsOf(cg, nodeOf(cg, 'struct', struct), 'contains');
}

/**
 * The structs named `name`, in source order. A fn-local type shares its
 * `qualifiedName` with a same-named type in another scope, so these are told
 * apart by where they start.
 */
function structsNamed(cg: CodeGraph, name: string): Node[] {
  return cg
    .getNodesByKind('struct')
    .filter((n) => n.name === name)
    .sort((a, b) => a.startLine - b.startLine);
}

/**
 * The names of what a node `contains`. An impl written through an alias names
 * its methods by the alias, so the owner is checked by the method's own name.
 */
function containedNames(cg: CodeGraph, node: Node): string[] {
  return cg
    .getOutgoingEdges(node.id)
    .filter((e) => e.kind === 'contains')
    .map((e) => cg.getNode(e.target)?.name ?? '')
    .sort();
}

const lines = (...l: string[]): string => [...l, ''].join('\n');

const FILES: Record<string, string> = {
  'Cargo.toml': lines('[package]', 'name = "locals"', 'version = "0.1.0"', 'edition = "2021"'),
  'src/lib.rs': lines(
    'pub mod m;',
    'pub mod top;',
    'pub mod inner;',
    '',
    'pub trait Plain {',
    '    fn plain(&self);',
    '}',
  ),
  'src/m.rs': lines('pub trait Deep {', '    fn deep(&self);', '}'),
  'src/top.rs': lines(
    'pub struct Top;',
    '',
    'impl crate::m::Deep for Top {',
    '    fn deep(&self) {}',
    '}',
  ),
  'src/inner/mod.rs': lines('pub mod child;', '', 'pub trait Sup {', '    fn sup(&self);', '}'),
  'src/inner/child.rs': lines(
    'use crate::Plain;',
    '',
    'pub fn host() {',
    '    struct ByName;',
    '    impl Plain for ByName {',
    '        fn plain(&self) {}',
    '    }',
    '',
    '    struct ByCratePath;',
    '    impl crate::m::Deep for ByCratePath {',
    '        fn deep(&self) {}',
    '    }',
    '',
    '    struct BySuper;',
    '    impl super::Sup for BySuper {',
    '        fn sup(&self) {}',
    '    }',
    '}',
  ),
};

describe('a Rust `impl Trait for Type` inside a function body', () => {
  it('control: a top-level `impl crate::m::Deep for Top` implements Deep', async () => {
    const cg = await indexed(FILES);
    try {
      expect(implemented(cg, 'Top')).toEqual(['Deep']);
    } finally {
      cg.close();
    }
  });

  it('`impl Plain for ByName` in a fn body implements Plain', async () => {
    const cg = await indexed(FILES);
    try {
      expect(implemented(cg, 'host::ByName')).toEqual(['Plain']);
      expect(reached(cg, 'Plain::plain')).toContain('ByName::plain');
    } finally {
      cg.close();
    }
  });

  it('`impl crate::m::Deep for ByCratePath` in a fn body implements Deep', async () => {
    const cg = await indexed(FILES);
    try {
      expect(implemented(cg, 'host::ByCratePath')).toEqual(['Deep']);
      expect(reached(cg, 'Deep::deep')).toEqual(expect.arrayContaining(['ByCratePath::deep', 'Top::deep']));
    } finally {
      cg.close();
    }
  });

  it('`impl super::Sup for BySuper` in a fn body implements Sup', async () => {
    const cg = await indexed(FILES);
    try {
      expect(implemented(cg, 'host::BySuper')).toEqual(['Sup']);
      expect(reached(cg, 'Sup::sup')).toContain('BySuper::sup');
    } finally {
      cg.close();
    }
  });
});

/** A one-file crate: `src/lib.rs` holds `pub trait T` followed by `body`. */
function crate(...body: string[]): Record<string, string> {
  return {
    'Cargo.toml': lines('[package]', 'name = "scopes"', 'version = "0.1.0"', 'edition = "2021"'),
    'src/lib.rs': lines('pub trait T {', '    fn run(&self);', '}', '', ...body),
  };
}

/**
 * The type an `impl Trait for Type` implements is found lexically: the impl's
 * enclosing scope (the fn it sits in, or the module) is searched first, then
 * the scopes around it, through enclosing module boundaries too (real Rust does
 * not look past a module without a `use`, so that part over-matches). A type
 * local to one fn is never visible to an impl outside that fn. The impl's
 * methods belong to that same type.
 */
describe('a Rust `impl Trait for Type` resolves its type by lexical scope', () => {
  it('a fn-local type shadows a module-level namesake, and owns the impl methods', async () => {
    const cg = await indexed(
      crate(
        'pub struct Local;',
        '',
        'pub fn host() {',
        '    struct Local;',
        '    impl T for Local {',
        '        fn run(&self) {}',
        '    }',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'Local')).toEqual([]);
      expect(implemented(cg, 'host::Local')).toEqual(['T']);
      expect(reached(cg, 'T::run')).toContain('Local::run');
      expect(contained(cg, 'host::Local')).toContain('Local::run');
      expect(contained(cg, 'Local')).not.toContain('Local::run');
    } finally {
      cg.close();
    }
  });

  it("an earlier fn's local type does not take a top-level impl, nor own its methods", async () => {
    const cg = await indexed(
      crate(
        'pub fn early() {',
        '    struct Other;',
        '}',
        '',
        'pub struct Other;',
        '',
        'impl T for Other {',
        '    fn run(&self) {}',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'early::Other')).toEqual([]);
      expect(implemented(cg, 'Other')).toEqual(['T']);
      expect(reached(cg, 'T::run')).toContain('Other::run');
      expect(contained(cg, 'Other')).toContain('Other::run');
      expect(contained(cg, 'early::Other')).not.toContain('Other::run');
    } finally {
      cg.close();
    }
  });

  it("an impl in a later fn for a module-level type is not taken by an earlier fn's namesake", async () => {
    const cg = await indexed(
      crate(
        'pub fn early() {',
        '    struct Other;',
        '}',
        '',
        'pub struct Other;',
        '',
        'pub fn later() {',
        '    impl T for Other {',
        '        fn run(&self) {}',
        '    }',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'early::Other')).toEqual([]);
      expect(implemented(cg, 'Other')).toEqual(['T']);
      expect(contained(cg, 'Other')).toContain('Other::run');
      expect(contained(cg, 'early::Other')).not.toContain('Other::run');
      expect(reached(cg, 'T::run')).toContain('Other::run');
    } finally {
      cg.close();
    }
  });

  it('an impl inside a fn for a module-level type implements the trait', async () => {
    const cg = await indexed(
      crate(
        'pub struct Top;',
        '',
        'pub fn wire() {',
        '    impl T for Top {',
        '        fn run(&self) {}',
        '    }',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'Top')).toEqual(['T']);
    } finally {
      cg.close();
    }
  });

  it('a path-qualified implementing type names the module-level type, never a fn-local namesake', async () => {
    const cg = await indexed(
      crate(
        'pub struct Local;',
        '',
        'pub fn host() {',
        '    struct Local;',
        '    impl T for crate::Local {',
        '        fn run(&self) {}',
        '    }',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'host::Local')).toEqual([]);
      expect(implemented(cg, 'Local')).toEqual(['T']);
      expect(contained(cg, 'Local')).toContain('Local::run');
      expect(contained(cg, 'host::Local')).not.toContain('Local::run');
    } finally {
      cg.close();
    }
  });

  // `fn host(){ { struct X; } impl T for X {} }`: the block's type is out of scope
  // at the impl, so the impl names the module-level X.
  it("a type declared in a sibling block is not the one a later impl in the fn names", async () => {
    const cg = await indexed(
      crate(
        'pub struct X;',
        '',
        'pub fn host() {',
        '    {',
        '        struct X;',
        '    }',
        '    impl T for X {',
        '        fn run(&self) {}',
        '    }',
        '}',
      ),
    );
    try {
      const types = structsNamed(cg, 'X');
      expect(types).toHaveLength(2);
      const [moduleX, blockX] = types as [Node, Node];
      expect(targetsOf(cg, moduleX, 'implements')).toEqual(['T']);
      expect(targetsOf(cg, blockX, 'implements')).toEqual([]);
      expect(targetsOf(cg, moduleX, 'contains')).toContain('X::run');
      expect(targetsOf(cg, blockX, 'contains')).not.toContain('X::run');
    } finally {
      cg.close();
    }
  });

  it('a qualified target in a fn-local module owns its impl and methods', async () => {
    const cg = await indexed(crate(
      'pub struct X;',
      'pub fn host() {',
      '    mod m { pub struct X; }',
      '    impl T for m::X { fn run(&self) {} }',
      '}',
    ));
    try {
      expect(implemented(cg, 'X')).toEqual([]);
      expect(implemented(cg, 'host::X')).toEqual(['T']);
      expect(reached(cg, 'T::run')).toContain('X::run');
      const types = structsNamed(cg, 'X');
      expect(types).toHaveLength(2);
      const [moduleX, localX] = types as [Node, Node];
      expect(targetsOf(cg, localX, 'contains')).toContain('X::run');
      expect(targetsOf(cg, moduleX, 'contains')).not.toContain('X::run');
    } finally {
      cg.close();
    }
  });

  it('qualified targets distinguish sibling fn-local modules, and the method belongs to the named one', async () => {
    const cg = await indexed(crate(
      'pub fn host() {',
      '    mod a { pub struct X; }',
      '    mod b { pub struct X; }',
      '    impl T for b::X { fn run(&self) {} }',
      '}',
    ));
    try {
      const types = structsNamed(cg, 'X');
      expect(types).toHaveLength(2);
      const [aX, bX] = types as [Node, Node];
      expect(targetsOf(cg, aX, 'implements')).toEqual([]);
      expect(targetsOf(cg, bX, 'implements')).toEqual(['T']);
      expect(reached(cg, 'T::run')).toContain('X::run');
      expect(targetsOf(cg, bX, 'contains')).toContain('X::run');
      expect(targetsOf(cg, aX, 'contains')).not.toContain('X::run');
    } finally {
      cg.close();
    }
  });

  // The type a same-file `use` brings into scope is the type the impl names.
  it('an impl for a type named by a same-file `use` implements the trait on that type', async () => {
    const cg = await indexed(
      crate(
        'mod m { pub struct X; }',
        'use m::X;',
        '',
        'impl T for X {',
        '    fn run(&self) {}',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'X')).toEqual(['T']);
      expect(reached(cg, 'T::run')).toContain('X::run');
      expect(contained(cg, 'X')).toContain('X::run');
    } finally {
      cg.close();
    }
  });

  it('an impl for a `use ... as` alias implements the aliased type, and a grouped sibling implements nothing', async () => {
    const cg = await indexed(
      crate(
        'mod n { pub struct Y; pub struct Z; }',
        'use n::{Y as Renamed, Z};',
        '',
        'impl T for Renamed {',
        '    fn run(&self) {}',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'Y')).toEqual(['T']);
      expect(implemented(cg, 'Z')).toEqual([]);
      expect(containedNames(cg, nodeOf(cg, 'struct', 'Y'))).toEqual(['run']);
      expect(containedNames(cg, nodeOf(cg, 'struct', 'Z'))).toEqual([]);
    } finally {
      cg.close();
    }
  });

  // A `use` of a re-export follows the re-export to the type it names.
  it('a `use` of a same-file `pub use` re-export names the type the re-export points to', async () => {
    const cg = await indexed(
      crate(
        'mod m { pub struct X; }',
        'mod api { pub use crate::m::X; }',
        'use api::X;',
        '',
        'impl T for X {',
        '    fn run(&self) {}',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'X')).toEqual(['T']);
      expect(reached(cg, 'T::run')).toContain('X::run');
    } finally {
      cg.close();
    }
  });

  // In a 2021 crate an absolute `::` path names an external crate, so a `use` of it
  // with an alias never names a local module's type.
  it('a leading `::` alias to an external crate links no local type', async () => {
    const cg = await indexed(
      crate(
        'mod remote { pub struct X; }',
        'use ::remote::X as External;',
        '',
        'impl T for External {',
        '    fn run(&self) {}',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'X')).toEqual([]);
      expect(contained(cg, 'X')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('an absolute `::` path to an external crate links no local module type', async () => {
    const cg = await indexed(
      crate(
        'mod remote { pub struct X; }',
        '',
        'impl T for ::remote::X {',
        '    fn run(&self) {}',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'X')).toEqual([]);
      expect(contained(cg, 'X')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  // Each alias names the other, so the walk never reaches a type. It must end, and link nothing.
  it('a cycle of `pub use` re-exports terminates and names no type', async () => {
    const cg = await indexed(
      crate(
        'mod a { pub use super::b::X; }',
        'mod b { pub use super::a::X; }',
        'use a::X;',
        '',
        'impl T for X {',
        '    fn run(&self) {}',
        '}',
      ),
    );
    try {
      expect(cg.getNodesByKind('struct')).toEqual([]);
      expect(reached(cg, 'T::run')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  // `self::` names the enclosing module and `super::` its parent, so each reaches a type in that module.
  it('a `self::` path to a type in the same inline module implements the trait', async () => {
    const cg = await indexed(
      crate(
        'mod inner {',
        '    use super::T;',
        '    pub struct X;',
        '    impl T for self::X {',
        '        fn run(&self) {}',
        '    }',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'X')).toEqual(['T']);
      expect(contained(cg, 'X')).toContain('X::run');
    } finally {
      cg.close();
    }
  });

  it('a `super::` path from an inline module to the outer type implements the trait', async () => {
    const cg = await indexed(
      crate(
        'pub struct X;',
        '',
        'mod inner {',
        '    impl super::T for super::X {',
        '        fn run(&self) {}',
        '    }',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'X')).toEqual(['T']);
      expect(contained(cg, 'X')).toContain('X::run');
    } finally {
      cg.close();
    }
  });

  // A `crate::` path resolves from the crate root, so it reaches a type in an out-of-line module file.
  it('a `crate::` path in an out-of-line module file names the type that file defines', async () => {
    const cg = await indexed({
      ...crate('pub mod m;'),
      'src/m.rs': lines('pub struct X;', '', 'impl crate::T for crate::m::X {', '    fn run(&self) {}', '}'),
    });
    try {
      expect(implemented(cg, 'X')).toEqual(['T']);
      expect(contained(cg, 'X')).toContain('X::run');
      expect(reached(cg, 'T::run')).toContain('X::run');
    } finally {
      cg.close();
    }
  });

  it('a `crate::` path to a module the crate lacks implements nothing, even beside a type of the same name', async () => {
    const cg = await indexed({
      ...crate('pub mod m;'),
      'src/m.rs': lines('pub struct W;', '', 'impl crate::T for crate::elsewhere::W {', '    fn run(&self) {}', '}'),
    });
    try {
      expect(implemented(cg, 'W')).toEqual([]);
      expect(contained(cg, 'W')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a `crate::` path through nested out-of-line modules names the type in the deepest file', async () => {
    const cg = await indexed({
      ...crate('pub mod a;'),
      'src/a/mod.rs': lines('pub mod b;'),
      'src/a/b.rs': lines('pub struct Deep;', '', 'impl crate::T for crate::a::b::Deep {', '    fn run(&self) {}', '}'),
    });
    try {
      expect(implemented(cg, 'Deep')).toEqual(['T']);
    } finally {
      cg.close();
    }
  });

  // A Cargo `[lib] path` makes that file the crate root. Its name does not show that, so
  // `crate::X` is searched from the file root as written.
  it('a Cargo `[lib]` path makes that file the crate root for `crate::` paths', async () => {
    const cg = await indexed({
      'Cargo.toml': lines(
        '[package]',
        'name = "scopes"',
        'version = "0.1.0"',
        'edition = "2021"',
        '',
        '[lib]',
        'path = "src/engine.rs"',
      ),
      'src/engine.rs': lines(
        'pub trait T {',
        '    fn run(&self);',
        '}',
        '',
        'pub struct X;',
        '',
        'impl T for crate::X {',
        '    fn run(&self) {}',
        '}',
      ),
    });
    try {
      expect(implemented(cg, 'X')).toEqual(['T']);
      expect(contained(cg, 'X')).toContain('X::run');
    } finally {
      cg.close();
    }
  });

  // Cargo makes src/engine.rs the crate root. Its guessed module path `engine` finds no
  // top-level X, so the path is read as written and reaches the inline `mod engine`.
  it('a `crate::` path through an inline module named like the crate root file names the type inside that module', async () => {
    const cg = await indexed({
      'Cargo.toml': lines(
        '[package]',
        'name = "scopes"',
        'version = "0.1.0"',
        'edition = "2021"',
        '',
        '[lib]',
        'path = "src/engine.rs"',
      ),
      'src/engine.rs': lines(
        'pub trait T {',
        '    fn run(&self);',
        '}',
        '',
        'mod engine {',
        '    pub struct X;',
        '}',
        '',
        'impl T for crate::engine::X {',
        '    fn run(&self) {}',
        '}',
      ),
    });
    try {
      expect(implemented(cg, 'X')).toEqual(['T']);
    } finally {
      cg.close();
    }
  });

  // In src/m.rs, `crate::m::X` is this file's own top-level X, not the inline `mod m`'s X
  // of the same name. The two are told apart by where they start, not by name.
  it('a file with a top-level `X` and an inline `mod m` holding its own `X` keeps the two apart by line', async () => {
    const cg = await indexed({
      'Cargo.toml': lines('[package]', 'name = "scopes"', 'version = "0.1.0"', 'edition = "2021"'),
      'src/lib.rs': lines('pub mod m;', 'pub trait T { fn run(&self); }'),
      'src/m.rs': lines(
        'pub struct X;',
        '',
        'mod m {',
        '    pub struct X;',
        '}',
        '',
        'impl crate::T for crate::m::X {',
        '    fn run(&self) {}',
        '}',
      ),
    });
    try {
      const types = structsNamed(cg, 'X');
      expect(types).toHaveLength(2);
      expect(types[1]!.startLine - types[0]!.startLine).toBe(3);
      const traits = types.map((n) => targetsOf(cg, n, 'implements'));
      expect(traits).toEqual([['T'], []]);
    } finally {
      cg.close();
    }
  });

  // The same file with the inline `mod m` first: a path must not take the first X in the file.
  it('the top-level `X` is named by `crate::m::X` even when an inline `mod m` with its own `X` comes first', async () => {
    const cg = await indexed({
      'Cargo.toml': lines('[package]', 'name = "scopes"', 'version = "0.1.0"', 'edition = "2021"'),
      'src/lib.rs': lines('pub mod m;', 'pub trait T { fn run(&self); }'),
      'src/m.rs': lines(
        'mod m {',
        '    pub struct X;',
        '}',
        '',
        'pub struct X;',
        '',
        'impl crate::T for crate::m::X {',
        '    fn run(&self) {}',
        '}',
      ),
    });
    try {
      const types = structsNamed(cg, 'X');
      expect(types).toHaveLength(2);
      const [inline, top] = types as [Node, Node];
      expect(targetsOf(cg, top, 'implements')).toEqual(['T']);
      expect(targetsOf(cg, inline, 'implements')).toEqual([]);
      expect(targetsOf(cg, top, 'contains')).toContain('X::run');
      expect(targetsOf(cg, inline, 'contains')).not.toContain('X::run');
    } finally {
      cg.close();
    }
  });

  // `fn host(){ impl T for X {} struct X; }`: Rust sees the fn-local `X` throughout its block, but the struct is extracted after the impl is visited, so the impl names no type; a module-level `X` is not taken instead.
  it.todo('known limit: a fn-local type declared after its impl is not seen');
  // Holds when the top-level X is declared before the impl. Declared after it, the stripped reading finds nothing and the path falls through to the inline X.
  it.todo('known limit: in a file Cargo names as the crate root by [lib] path that holds both a top-level type and an inline module named like the file with a same-named type, crate::<file>::X takes the top-level type');
});
