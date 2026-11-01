/**
 * A Rust call written as a path through a workspace crate —
 * `persistence_kit::query_in_chunks(1)`, `persistence_kit::store::open_store()`,
 * `model_runtime_kit::InstalledModelPackage::read(1)` — is the item that crate
 * declares, found through the crate's `lib.rs`: a module it declares, or a name
 * it passes on with `pub use m::{a, b}` or `pub use m::*` from a private module.
 * The crate name is the `[lib] name` (or the package name with `-` as `_`), and
 * only a crate the caller's `Cargo.toml` lists as a dependency is searched, so a
 * namesake in a workspace crate the caller does not depend on is never picked.
 * A `crate::module::Type::method` path reaches the method even when the `impl`
 * lives in another file than the type, and a bin target under `src/bin/` calls
 * into its dependencies the same way. A path whose first segment a `use` takes
 * from the standard library (`use std::fs; fs::read(..)`), std's own
 * `Default::default()` / `String::from(..)` and a path through std to a type
 * (`core::cell::RefCell::new(..)`) link to nothing in the project, whatever
 * namesake the project declares.
 * A path to a type in one inline module never reaches the method of a
 * namesake type in another inline module of the same file, nor the method of
 * a namesake type a function declares in its own body, nor that of the
 * module a `use` (`use crate::b as a;`) or a `mod` (`mod a { … }`) in the
 * function's body shadows, nor the method an `impl` for a reference to the
 * type (`impl Open for &crate::Cache`) writes. A path to a type's method with
 * a leading `::` (`::a::Cache::open()`), which since Rust 2018 names the
 * external crate `a`, never reaches the calling crate's own `mod a`'s method;
 * it is left unlinked.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const PK = 'packages/kits/PersistenceKit/rust';
const MRK = 'packages/kits/ModelRuntimeKit/rust';
const LK = 'packages/kits/LocusKit/rust';
const OK = 'packages/kits/OtherKit/rust';
const IK = 'packages/kits/InlineKit/rust';
const FLK = 'packages/kits/FnLocalKit/rust';
const UAK = 'packages/kits/UseAliasKit/rust';
const SNK = 'packages/kits/StdNamesakeKit/rust';
const ORK = 'packages/kits/OrderKit/rust';
const RIK = 'packages/kits/RefImplKit/rust';
const EAK = 'packages/kits/ExternA/rust';
const ERK = 'packages/kits/ExternRootKit/rust';

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-crate-path-'));
  const files: Record<string, string> = {
    'Cargo.toml': `[workspace]
resolver = "2"
members = [
    "${PK}",
    "${MRK}",
    "${LK}",
    "${OK}",
    "${IK}",
    "${FLK}",
    "${UAK}",
    "${SNK}",
    "${ORK}",
    "${RIK}",
    "${EAK}",
    "${ERK}",
]
`,
    [`${PK}/Cargo.toml`]: `[package]
name = "persistence-kit"
version = "0.1.0"

[lib]
name = "persistence_kit"
path = "src/lib.rs"
`,
    [`${PK}/src/lib.rs`]: `mod in_list;
pub mod store;
pub use in_list::{query_in_chunks, delete_in_chunks};
`,
    [`${PK}/src/in_list.rs`]: `pub fn query_in_chunks(n: usize) -> usize {
    n
}

pub fn delete_in_chunks(n: usize) -> usize {
    n
}
`,
    [`${PK}/src/store.rs`]: `pub fn open_store() -> usize {
    0
}
`,
    [`${MRK}/Cargo.toml`]: `[package]
name = "model-runtime-kit"
version = "0.1.0"
`,
    [`${MRK}/src/lib.rs`]: `pub mod process_policy;
mod installed_package;
pub use installed_package::*;
pub mod worker_command;
`,
    [`${MRK}/src/process_policy.rs`]: `pub fn is_coreml_contention(s: &str) -> bool {
    s.is_empty()
}
`,
    [`${MRK}/src/installed_package.rs`]: `pub struct InstalledModelPackage {
    pub id: usize,
}

impl InstalledModelPackage {
    pub fn read(id: usize) -> InstalledModelPackage {
        InstalledModelPackage { id }
    }
}
`,
    [`${MRK}/src/worker_command.rs`]: `pub fn run_from_args() {}
`,
    [`${LK}/Cargo.toml`]: `[package]
name = "locus-kit"
version = "0.1.0"

[dependencies]
persistence-kit = { path = "../../PersistenceKit/rust" }
model-runtime-kit = { path = "../../ModelRuntimeKit/rust" }

[dev-dependencies]
persistence-kit = { path = "../../PersistenceKit/rust", features = ["test-support"] }
`,
    [`${LK}/src/lib.rs`]: `pub mod fact_enumeration;
mod fact_canonical_deletion;
pub mod callers;
pub mod uses_std;
pub mod m;
pub mod shapes;
`,
    [`${LK}/src/fact_enumeration.rs`]: `pub struct FactCanonicalValueStore;

pub fn enumerate() -> usize {
    0
}
`,
    // The impl lives in a different file than the struct.
    [`${LK}/src/fact_canonical_deletion.rs`]: `impl crate::fact_enumeration::FactCanonicalValueStore {
    pub(crate) fn delete_for_source(n: usize) -> usize {
        n
    }
}
`,
    // A trait, and a struct of the same name in another module with an
    // inherent method of the trait's method's name.
    [`${LK}/src/m.rs`]: `pub trait SomeTrait {
    fn get() -> usize;
}
`,
    [`${LK}/src/shapes.rs`]: `pub struct SomeTrait;

impl SomeTrait {
    pub fn get() -> usize {
        0
    }
}
`,
    [`${LK}/src/callers.rs`]: `pub fn via_reexport_query() -> usize {
    persistence_kit::query_in_chunks(1)
}

pub fn via_reexport_delete() -> usize {
    persistence_kit::delete_in_chunks(1)
}

pub fn via_crate_module() -> usize {
    persistence_kit::store::open_store()
}

pub fn via_crate_module_policy() -> bool {
    model_runtime_kit::process_policy::is_coreml_contention("x")
}

pub fn via_crate_type_method() -> usize {
    model_runtime_kit::InstalledModelPackage::read(1).id
}

pub fn via_crate_impl_elsewhere() -> usize {
    crate::fact_enumeration::FactCanonicalValueStore::delete_for_source(2)
}

pub fn control_crate_fn() -> usize {
    crate::fact_enumeration::enumerate()
}

pub fn via_trait_path() -> usize {
    crate::m::SomeTrait::get()
}

pub fn via_missing_module() -> usize {
    crate::nowhere::InstalledModelPackage::read(1).id
}

pub fn via_std_traits() -> String {
    let _n: usize = Default::default();
    String::from("x")
}
`,
    [`${LK}/src/uses_std.rs`]: `use std::fs;

pub fn loads() {
    let _ = fs::read("x");
}
`,
    [`${LK}/src/bin/worker.rs`]: `fn main() {
    model_runtime_kit::worker_command::run_from_args();
}
`,
    // A workspace crate LocusKit does not depend on, with namesakes.
    [`${OK}/Cargo.toml`]: `[package]
name = "other-kit"
version = "0.1.0"
`,
    [`${OK}/src/lib.rs`]: `pub mod store;

pub fn query_in_chunks(n: usize) -> usize {
    n
}

pub fn delete_in_chunks(n: usize) -> usize {
    n
}

pub struct InstalledModelPackage {
    pub id: usize,
}

impl InstalledModelPackage {
    pub fn read(id: usize) -> InstalledModelPackage {
        InstalledModelPackage { id }
    }
}
`,
    [`${OK}/src/store.rs`]: `pub fn open_store() -> usize {
    1
}
`,
    // Two inline modules in one file, each with a `Cache`: a's has only a
    // trait's provided `open`, b's an inherent `open` of its own.
    [`${IK}/Cargo.toml`]: `[package]
name = "inline-kit"
version = "0.1.0"
`,
    [`${IK}/src/lib.rs`]: `pub mod a {
    pub struct Cache;
    pub trait Open {
        fn open() -> usize {
            1
        }
    }
    impl Open for Cache {}
}

pub mod b {
    pub struct Cache;
    impl Cache {
        pub fn open() -> usize {
            2
        }
    }
}

use a::Open;

pub fn caller() -> usize {
    crate::a::Cache::open()
}

pub fn control_b() -> usize {
    crate::b::Cache::open()
}
`,
    // The crate root's `Cache` has only a trait's provided `open`; a function
    // declares a `Cache` of its own, whose inherent `open` is no root `Cache`'s.
    [`${FLK}/Cargo.toml`]: `[package]
name = "fn-local-kit"
version = "0.1.0"
`,
    [`${FLK}/src/lib.rs`]: `pub struct Cache;
pub trait Open {
    fn open() -> usize {
        1
    }
}
impl Open for Cache {}

pub fn build_local() {
    struct Cache;
    impl Cache {
        pub fn open() -> usize {
            2
        }
    }
    let _ = Cache::open();
}

pub fn caller() -> usize {
    crate::Cache::open()
}
`,
    // Two modules with a `Cache` each; a `use` in caller's body makes `a`
    // name crate::b there, as a `mod a` in caller_mod's body makes `a` that
    // module there, so neither's `a::Cache::open()` is module a's.
    [`${UAK}/Cargo.toml`]: `[package]
name = "use-alias-kit"
version = "0.1.0"
`,
    [`${UAK}/src/lib.rs`]: `pub mod a {
    pub struct Cache;
    impl Cache {
        pub fn open() -> usize {
            1
        }
    }
}

pub mod b {
    pub struct Cache;
    impl Cache {
        pub fn open() -> usize {
            2
        }
    }
}

pub fn caller() -> usize {
    use crate::b as a;
    a::Cache::open()
}

pub fn control_a() -> usize {
    a::Cache::open()
}

pub fn caller_mod() -> usize {
    mod a {
        pub use crate::b::Cache;
    }
    a::Cache::open()
}
`,
    // A crate whose own `core::cell` module declares a `RefCell::new`: in
    // user.rs, which declares no `core`, `core::cell::RefCell` is std's.
    [`${SNK}/Cargo.toml`]: `[package]
name = "std-namesake-kit"
version = "0.1.0"
`,
    [`${SNK}/src/lib.rs`]: `pub mod core;
pub mod user;
`,
    [`${SNK}/src/user.rs`]: `pub fn caller() {
    let _a = core::cell::RefCell::new(1);
    let _b = std::cell::RefCell::new(2);
}

pub fn control() -> usize {
    crate::core::cell::RefCell::new(3).0
}
`,
    [`${SNK}/src/core/mod.rs`]: `pub mod cell;
`,
    [`${SNK}/src/core/cell.rs`]: `pub struct RefCell(pub usize);

impl RefCell {
    pub fn new(n: usize) -> RefCell {
        RefCell(n)
    }
}
`,
    // A function declared before the crate's own `pub mod a` declares a
    // `mod a` of its own; at module level `a` is still the crate's module a.
    [`${ORK}/Cargo.toml`]: `[package]
name = "order-kit"
version = "0.1.0"
`,
    [`${ORK}/src/lib.rs`]: `pub fn decoy() {
    mod a {
        pub use crate::b::Cache;
    }
}

pub mod a {
    pub struct Cache;
    impl Cache {
        pub fn open() -> usize {
            1
        }
    }
}

pub mod b {
    pub struct Cache;
    impl Cache {
        pub fn open() -> usize {
            2
        }
    }
}

pub fn via_order() -> usize {
    a::Cache::open()
}
`,
    // `Cache` takes the trait's provided `open`; the `impl` for `&Cache`
    // writes its own, which is the reference type's, never `Cache`'s.
    [`${RIK}/Cargo.toml`]: `[package]
name = "ref-impl-kit"
version = "0.1.0"
`,
    [`${RIK}/src/lib.rs`]: `pub struct Cache;

pub trait Open {
    fn open() -> usize {
        1
    }
}

impl Open for Cache {}

impl Open for &crate::Cache {
    fn open() -> usize {
        3
    }
}

pub fn caller() -> usize {
    crate::Cache::open()
}
`,
    // The external crate `a`, and a crate that depends on it and declares a
    // `mod a` of its own: `::a::Cache::open()` names the external crate's
    // (edition 2021; in 2015 a leading `::` would name the crate root's `mod a`).
    [`${EAK}/Cargo.toml`]: `[package]
name = "a"
version = "0.1.0"
edition = "2021"
`,
    [`${EAK}/src/lib.rs`]: `pub struct Cache;

impl Cache {
    pub fn open() -> usize {
        2
    }
}
`,
    [`${ERK}/Cargo.toml`]: `[package]
name = "extern-root-kit"
version = "0.1.0"
edition = "2021"

[dependencies]
a = { path = "../../ExternA/rust" }
`,
    [`${ERK}/src/lib.rs`]: `pub mod a {
    pub struct Cache;
    impl Cache {
        pub fn open() -> usize {
            1
        }
    }
}

pub fn caller() -> usize {
    ::a::Cache::open()
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** What the function `name` in `file` calls, as `kind name file`. */
const callsFrom = (file: string, name: string): string[] => {
  const fn = cg.getNodesInFile(file).find((n) => n.name === name);
  expect(fn, `${name} in ${file}`).toBeDefined();
  return cg.getOutgoingEdgesFrom([fn!.id]).filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!).map((t) => `${t.kind} ${t.name} ${t.filePath}`);
};

const CALLERS = `${LK}/src/callers.rs`;

describe('Rust calls through a workspace crate path', () => {
  it('reach a function the crate passes on with `pub use m::{a, b}`', () => {
    expect(callsFrom(CALLERS, 'via_reexport_query')).toEqual([`function query_in_chunks ${PK}/src/in_list.rs`]);
    expect(callsFrom(CALLERS, 'via_reexport_delete')).toEqual([`function delete_in_chunks ${PK}/src/in_list.rs`]);
  });

  it('walk a module path through another crate to its file', () => {
    expect(callsFrom(CALLERS, 'via_crate_module')).toEqual([`function open_store ${PK}/src/store.rs`]);
  });

  it('walk a module path through a crate named only by its package name', () => {
    expect(callsFrom(CALLERS, 'via_crate_module_policy'))
      .toEqual([`function is_coreml_contention ${MRK}/src/process_policy.rs`]);
  });

  it('reach a type\'s method behind a private module the crate passes on with a glob', () => {
    expect(callsFrom(CALLERS, 'via_crate_type_method'))
      .toEqual([`method read ${MRK}/src/installed_package.rs`]);
  });

  it('reach a `crate::module::Type::method` whose impl lives in another file', () => {
    expect(callsFrom(CALLERS, 'via_crate_impl_elsewhere'))
      .toEqual([`method delete_for_source ${LK}/src/fact_canonical_deletion.rs`]);
  });

  it('call into a dependency from a bin target', () => {
    expect(callsFrom(`${LK}/src/bin/worker.rs`, 'main'))
      .toEqual([`function run_from_args ${MRK}/src/worker_command.rs`]);
  });

  it('never land in a workspace crate the caller does not depend on', () => {
    for (const name of ['via_reexport_query', 'via_reexport_delete', 'via_crate_module', 'via_crate_type_method']) {
      expect(callsFrom(CALLERS, name).filter((t) => t.includes(OK))).toEqual([]);
    }
  });

  it('leave a path whose head a `use` takes from the standard library unlinked', () => {
    expect(callsFrom(`${LK}/src/uses_std.rs`, 'loads')).toEqual([]);
  });

  it('link std\'s `Default::default()` and `String::from(..)` to nothing in the project', () => {
    expect(callsFrom(CALLERS, 'via_std_traits')).toEqual([]);
  });

  // The trait's own declaration (m.rs) is what the path names; the namesake struct's inherent `get` (shapes.rs) is not.
  it('reach a path to a trait\'s function at the trait\'s own declaration, never a namesake struct\'s method', () => {
    expect(callsFrom(CALLERS, 'via_trait_path')).toEqual([`method get ${LK}/src/m.rs`]);
  });

  it('leave a path through a module that does not exist unlinked', () => {
    expect(callsFrom(CALLERS, 'via_missing_module')).toEqual([]);
  });

  it('never reach a namesake type\'s method in another inline module of the same file', () => {
    const file = `${IK}/src/lib.rs`;
    const caller = cg.getNodesInFile(file).find((n) => n.kind === 'function' && n.name === 'caller');
    expect(caller, 'caller').toBeDefined();
    // By identity and line: both `open`s share the file and the name.
    const opens = cg.getNodesInFile(file).filter((n) => n.kind === 'method' && n.name === 'open');
    const traitOpen = opens.filter((n) => n.startLine === 4);
    const bOpen = opens.filter((n) => n.startLine === 14);
    expect(bOpen.length, 'b::Cache::open at line 14').toBe(1);
    const targets = cg.getOutgoingEdgesFrom([caller!.id]).filter((e) => e.kind === 'calls').map((e) => e.target);
    expect(targets).not.toContain(bOpen[0]!.id);
    // Nothing, or a's trait's provided `open`; never another method.
    expect(targets.filter((t) => !traitOpen.some((n) => n.id === t))).toEqual([]);
    // The path to b's own type still reaches b's method (control).
    expect(callsFrom(file, 'control_b')).toEqual([`method open ${file}`]);
    const controlB = cg.getNodesInFile(file).find((n) => n.kind === 'function' && n.name === 'control_b');
    expect(cg.getOutgoingEdgesFrom([controlB!.id]).filter((e) => e.kind === 'calls').map((e) => e.target)).toEqual([bOpen[0]!.id]);
  });

  it('never reach the method of a namesake type a function declares in its own body', () => {
    const file = `${FLK}/src/lib.rs`;
    const nodes = cg.getNodesInFile(file);
    const caller = nodes.find((n) => n.kind === 'function' && n.name === 'caller');
    expect(caller, 'caller').toBeDefined();
    // By identity and line: the trait's provided `open` (line 3) and
    // build_local's own `Cache::open` (line 12), whatever kind it is stored as.
    const opens = nodes.filter((n) => n.name === 'open' && (n.kind === 'method' || n.kind === 'function'));
    const traitOpen = opens.filter((n) => n.startLine === 3);
    const localOpen = opens.filter((n) => n.startLine === 12);
    expect(localOpen.length, 'build_local\'s Cache::open at line 12').toBe(1);
    const targets = cg.getOutgoingEdgesFrom([caller!.id]).filter((e) => e.kind === 'calls').map((e) => e.target);
    expect(targets).not.toContain(localOpen[0]!.id);
    // Nothing, or the trait's provided `open`; never another method.
    expect(targets.filter((t) => !traitOpen.some((n) => n.id === t))).toEqual([]);
  });

  it('never reach the method of the module a `use` in the function\'s body shadows', () => {
    const file = `${UAK}/src/lib.rs`;
    const nodes = cg.getNodesInFile(file);
    const callTargets = (name: string): string[] => {
      const fn = nodes.find((n) => n.kind === 'function' && n.name === name);
      expect(fn, name).toBeDefined();
      return cg.getOutgoingEdgesFrom([fn!.id]).filter((e) => e.kind === 'calls').map((e) => e.target);
    };
    // By identity and line: both `open`s share the file and the name.
    const opens = nodes.filter((n) => n.kind === 'method' && n.name === 'open');
    const aOpen = opens.filter((n) => n.startLine === 4);
    const bOpen = opens.filter((n) => n.startLine === 13);
    expect(aOpen.length, 'a::Cache::open at line 4').toBe(1);
    expect(bOpen.length, 'b::Cache::open at line 13').toBe(1);
    // `a` is crate::b in caller's body: b's method, never module a's.
    const targets = callTargets('caller');
    expect(targets).not.toContain(aOpen[0]!.id);
    expect(targets).toEqual([bOpen[0]!.id]);
    // Where no `use` in the body binds `a`, the path is module a's (control).
    expect(callTargets('control_a')).toEqual([aOpen[0]!.id]);
  });

  it('never reach the method of the module a `mod` in the function\'s body shadows', () => {
    const file = `${UAK}/src/lib.rs`;
    const nodes = cg.getNodesInFile(file);
    const callTargets = (name: string): string[] => {
      const fn = nodes.find((n) => n.kind === 'function' && n.name === name);
      expect(fn, name).toBeDefined();
      return cg.getOutgoingEdgesFrom([fn!.id]).filter((e) => e.kind === 'calls').map((e) => e.target);
    };
    const opens = nodes.filter((n) => n.kind === 'method' && n.name === 'open');
    const aOpen = opens.filter((n) => n.startLine === 4);
    const bOpen = opens.filter((n) => n.startLine === 13);
    expect(aOpen.length, 'a::Cache::open at line 4').toBe(1);
    expect(bOpen.length, 'b::Cache::open at line 13').toBe(1);
    // `mod a { pub use crate::b::Cache; }` in caller_mod's body is `a` there:
    // b's method or nothing, never module a's.
    const targets = callTargets('caller_mod');
    expect(targets).not.toContain(aOpen[0]!.id);
    expect(targets.filter((t) => t !== bOpen[0]!.id)).toEqual([]);
    // Outside that body, `a` is still module a (control).
    expect(callTargets('control_a')).toEqual([aOpen[0]!.id]);
  });

  it('reach module a\'s method when a function declared before `pub mod a` declares a `mod a` of its own', () => {
    const file = `${ORK}/src/lib.rs`;
    const nodes = cg.getNodesInFile(file);
    const viaOrder = nodes.find((n) => n.kind === 'function' && n.name === 'via_order');
    expect(viaOrder, 'via_order').toBeDefined();
    // By identity and line: both `open`s share the file and the name.
    const opens = nodes.filter((n) => n.kind === 'method' && n.name === 'open');
    const aOpen = opens.filter((n) => n.startLine === 10);
    const bOpen = opens.filter((n) => n.startLine === 19);
    expect(aOpen.length, 'a::Cache::open at line 10').toBe(1);
    expect(bOpen.length, 'b::Cache::open at line 19').toBe(1);
    const targets = cg.getOutgoingEdgesFrom([viaOrder!.id]).filter((e) => e.kind === 'calls').map((e) => e.target);
    expect(targets, `a=${aOpen[0]!.id} b=${bOpen[0]!.id}`).toEqual([aOpen[0]!.id]);
  });

  it('never reach the method of an `impl` for a reference to the type', () => {
    const file = `${RIK}/src/lib.rs`;
    const nodes = cg.getNodesInFile(file);
    const caller = nodes.find((n) => n.kind === 'function' && n.name === 'caller');
    expect(caller, 'caller').toBeDefined();
    // By identity and line: the trait's provided `open` (line 4) and the
    // `&crate::Cache` impl's own `open` (line 12) share the file and the name.
    const opens = nodes.filter((n) => n.name === 'open' && (n.kind === 'method' || n.kind === 'function'));
    const traitOpen = opens.filter((n) => n.startLine === 4);
    const refOpen = opens.filter((n) => n.startLine === 12);
    expect(traitOpen.length, 'Open::open at line 4').toBe(1);
    expect(refOpen.length, '&Cache\'s open at line 12').toBe(1);
    const targets = cg.getOutgoingEdgesFrom([caller!.id]).filter((e) => e.kind === 'calls').map((e) => e.target);
    const ids = `trait=${traitOpen[0]!.id} ref=${refOpen[0]!.id}`;
    expect(targets, ids).not.toContain(refOpen[0]!.id);
    // No edge: no `impl` of `Cache` itself writes an `open`, and a trait's
    // provided method is no `Cache::open` the index holds.
    expect(targets, ids).toEqual([]);
  });

  it('never reach the calling crate\'s own `mod a`\'s method through a `::a::Type::method` path', () => {
    const file = `${ERK}/src/lib.rs`;
    const nodes = cg.getNodesInFile(file);
    const caller = nodes.find((n) => n.kind === 'function' && n.name === 'caller');
    expect(caller, 'caller').toBeDefined();
    // By identity and line: the local `mod a`'s `Cache::open` (line 4) and
    // the external crate a's (line 4 of its own lib.rs).
    const localOpen = nodes.filter((n) => n.kind === 'method' && n.name === 'open' && n.startLine === 4);
    const externOpen = cg.getNodesInFile(`${EAK}/src/lib.rs`).filter((n) => n.kind === 'method' && n.name === 'open' && n.startLine === 4);
    expect(localOpen.length, 'local a::Cache::open at line 4').toBe(1);
    expect(externOpen.length, 'crate a\'s Cache::open at line 4').toBe(1);
    const targets = cg.getOutgoingEdgesFrom([caller!.id]).filter((e) => e.kind === 'calls').map((e) => e.target);
    const ids = `local=${localOpen[0]!.id} extern=${externOpen[0]!.id}`;
    expect(targets, ids).not.toContain(localOpen[0]!.id);
    // No edge: in edition 2018+ (as this 2021 fixture is) a leading `::` names
    // an external crate, so the path is not the crate's own `mod a`'s; the
    // external crate is not walked either.
    expect(targets, ids).toEqual([]);
  });

  it('link a std path to a type to nothing, never the project\'s namesake type\'s method', () => {
    const file = `${SNK}/src/user.rs`;
    expect(callsFrom(file, 'caller')).toEqual([]);
    // The project's own `RefCell::new` is reachable by its own path (control).
    expect(callsFrom(file, 'control')).toEqual([`method new ${SNK}/src/core/cell.rs`]);
  });

  it('still reach a `crate::module::fn` in the caller\'s own crate (control)', () => {
    expect(callsFrom(CALLERS, 'control_crate_fn')).toEqual([`function enumerate ${LK}/src/fact_enumeration.rs`]);
  });
});
