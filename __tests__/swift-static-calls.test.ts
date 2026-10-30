/**
 * A Swift static call `Type.member()` lands on the member that type declares.
 *
 * A single capitalised receiver segment with a lowercase member (not `Self.`)
 * whose receiver is a project Swift type resolves on that type: its own
 * member, one declared in an `extension Type` in any file, one inherited from
 * a project supertype or a protocol extension it conforms to (of a class
 * override chain, the nearest override; of two unrelated supertypes, neither),
 * or a member of a bare nested type named in its scope. These resolve at confidence 0.9 with
 * `resolvedBy: 'qualified-name'`, not at the lower confidence a by-name match
 * gives.
 *
 * When several modules declare the type, the caller's own copy wins (same
 * file, then nearest directory); a tie gives no edge. Of overloads in the type
 * and its extensions (in any file, a module-qualified `extension Kit.Type`
 * too), the call's argument labels pick, never one another module's copy
 * declares. When the type does not declare the member, there is no `calls`
 * edge, never one to another type's same-named member nor to a local function
 * of one of its methods. A receiver that names no project type is left to the
 * name matcher; an SDK type's static call (`JSONDecoder.make()`) gets no edge.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

interface Call {
  /** `<file>:<qualifiedName>` of the target. */
  target: string;
  confidence: unknown;
  resolvedBy: unknown;
}

function makeProject(prefix: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

/** The Swift `calls` edges out of the one function or method named `caller`. */
function callsFrom(cg: CodeGraph, caller: string): Call[] {
  const from = cg
    .getNodesByName(caller)
    .filter((n) => n.language === 'swift' && (n.kind === 'function' || n.kind === 'method'));
  expect(from.map((n) => n.qualifiedName), caller).toHaveLength(1);
  return cg
    .getOutgoingEdgesFrom([from[0]!.id], ['calls'])
    .map((e) => ({ edge: e, node: cg.getNode(e.target) }))
    .filter(({ node }) => node && node.language === 'swift')
    .map(({ edge, node }) => ({
      target: `${node!.filePath}:${node!.qualifiedName}`,
      confidence: edge.metadata?.confidence,
      resolvedBy: edge.metadata?.resolvedBy,
    }));
}

/** The one call from `caller` to a target whose `<file>:<qualifiedName>` is `target`. */
function onlyCall(cg: CodeGraph, caller: string, target: string): Call {
  const calls = callsFrom(cg, caller);
  expect(calls.map((c) => c.target), JSON.stringify(calls)).toEqual([target]);
  return calls[0]!;
}

function expectQualified(call: Call): void {
  expect(call.resolvedBy, JSON.stringify(call)).toBe('qualified-name');
  expect(call.confidence, JSON.stringify(call)).toBeGreaterThanOrEqual(0.9);
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe('Swift: a static call on a project type', () => {
  let cg: CodeGraph;
  beforeAll(async () => {
    const root = makeProject('cg-swift-static-calls-', {
      'Sources/App/TestHelpers.swift': `enum TestHelpers { static func make() -> Int { 1 } }
`,
      'Sources/App/TestHelpers+Extra.swift': `extension TestHelpers { static func extra() {} }
`,
      'Sources/App/Use.swift': `func useMake() { _ = TestHelpers.make() }
func useExtra() { TestHelpers.extra() }
`,
      'Sources/App/Decode.swift': `import Foundation
func decode() { _ = JSONDecoder.make() }
`,
      'Sources/App/Builders.swift': `struct Builder { static func build() -> Builder { Builder() } }
final class Factory { class func create() -> Factory { Factory() } }
func useBuild() { _ = Builder.build() }
func useCreate() { _ = Factory.create() }
`,
      'Sources/App/Proto.swift': `protocol Proto {}
extension Proto { static func pdefault() {} }
enum Conf: Proto {}
func usePdefault() { Conf.pdefault() }
`,
      'Sources/App/Nested.swift': `enum Outer {
    enum Inner { static func f() {} }
    static func g() { Inner.f() }
}
`,
      'Sources/App/Box.swift': `struct Box { func open() {} }
func useBox(box: Box) { box.open() }
`,
    });
    roots.push(root);
    cg = await CodeGraph.init(root, { index: true });
  });
  afterAll(() => cg?.close());

  it('resolves a call on an enum namespace to its own static member', () => {
    expectQualified(onlyCall(cg, 'useMake', 'Sources/App/TestHelpers.swift:TestHelpers::make'));
  });

  it('gives no calls edge when the receiver names no project type', () => {
    // `TestHelpers.make` exists, but `JSONDecoder` is not a project type.
    expect(callsFrom(cg, 'decode')).toEqual([]);
  });

  it('resolves a call on a struct or a class to its own static member', () => {
    expectQualified(onlyCall(cg, 'useBuild', 'Sources/App/Builders.swift:Builder::build'));
    expectQualified(onlyCall(cg, 'useCreate', 'Sources/App/Builders.swift:Factory::create'));
  });

  it('resolves a member declared in an extension in another file', () => {
    const call = onlyCall(cg, 'useExtra', 'Sources/App/TestHelpers+Extra.swift:TestHelpers::extra');
    expectQualified(call);
  });

  it('resolves a member a conformed protocol extension supplies', () => {
    expectQualified(onlyCall(cg, 'usePdefault', 'Sources/App/Proto.swift:Proto::pdefault'));
  });

  it('resolves a bare nested type named inside its outer type', () => {
    expectQualified(onlyCall(cg, 'g', 'Sources/App/Nested.swift:Outer::Inner::f'));
  });

  it("resolves a call on a lowercase receiver through the variable's type, not as a type", () => {
    // Here `box` is useBox's parameter of type `Box`, so the call resolves through that type.
    const call = onlyCall(cg, 'useBox', 'Sources/App/Box.swift:Box::open');
    expect(call.confidence).toBeGreaterThanOrEqual(BOX_OPEN_CONFIDENCE);
  });
});

describe('Swift: a static call on a type several modules declare', () => {
  let cg: CodeGraph;
  const DECL = `enum DeterministicTestID { static func make() -> String { "" } }
`;
  beforeAll(async () => {
    const root = makeProject('cg-swift-static-modules-', {
      'Tests/ATests/DeterministicTestID.swift': DECL,
      'Tests/BTests/DeterministicTestID.swift': DECL,
      'Tests/BTests/UseB.swift': `func useB() { _ = DeterministicTestID.make() }
`,
      'Tests/CTests/UseC.swift': `func useC() { _ = DeterministicTestID.make() }
`,
    });
    roots.push(root);
    cg = await CodeGraph.init(root, { index: true });
  });
  afterAll(() => cg?.close());

  it("resolves to the caller's own module's copy", () => {
    expectQualified(
      onlyCall(cg, 'useB', 'Tests/BTests/DeterministicTestID.swift:DeterministicTestID::make'),
    );
  });

  it('gives no calls edge when no copy is nearer than another', () => {
    expect(callsFrom(cg, 'useC')).toEqual([]);
  });

  // Known limit (a new case class, from the mootx01-ee audit): a test file with
  // `@testable import ModA` calls `ReviewAction.suggestions()`, and
  // `Sources/ModA` and `Sources/ModB` both declare a top-level `ReviewAction`,
  // each as near the caller's `Tests/ModATests` directory as the other. Only
  // ModA's copy is visible there, but declarationFor reads no imports, so the
  // directory tie leaves the call with no edge.
  it.todo("resolves to the copy in the module the caller's file imports when the copies tie by directory");
});

describe('Swift: a static call a class override chain supplies', () => {
  let cg: CodeGraph;
  beforeAll(async () => {
    const root = makeProject('cg-swift-static-overrides-', {
      'Sources/App/Chain.swift': `class Base { class func make() -> Int { 1 } }
class Middle: Base { override class func make() -> Int { 2 } }
class Leaf: Middle {}
func useLeaf() { _ = Leaf.make() }
func useMiddle() { _ = Middle.make() }
`,
      'Sources/App/Siblings.swift': `protocol Left {}
extension Left { static func pick() {} }
protocol Right {}
extension Right { static func pick() {} }
struct Both: Left, Right {}
func useBoth() { Both.pick() }
`,
    });
    roots.push(root);
    cg = await CodeGraph.init(root, { index: true });
  });
  afterAll(() => cg?.close());

  it("resolves an inherited call to the nearest ancestor's override", () => {
    // `Middle.make` overrides `Base.make`, so `Leaf.make()` runs Middle's.
    expectQualified(onlyCall(cg, 'useLeaf', 'Sources/App/Chain.swift:Middle::make'));
  });

  it('resolves a call on the overriding class to its own member', () => {
    expectQualified(onlyCall(cg, 'useMiddle', 'Sources/App/Chain.swift:Middle::make'));
  });

  it('gives no calls edge when two unrelated supertypes supply the member', () => {
    // Swift rejects `Both.pick()` as ambiguous; neither extension is the target.
    expect(callsFrom(cg, 'useBoth')).toEqual([]);
  });
});

describe('Swift: a static call on a project type that lacks the member', () => {
  it("gives no calls edge to another type's same-named member", async () => {
    // `MyTool.main()` is supplied by a library (ArgumentParser); `Other.main`
    // is the only `main` in the project.
    const root = makeProject('cg-swift-static-undeclared-', {
      'Sources/Tool/MyTool.swift': `struct MyTool {}
`,
      'Sources/Tool/Other.swift': `struct Other { static func main() {} }
`,
      'Sources/Tool/Run.swift': `func run() { MyTool.main() }
`,
    });
    roots.push(root);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(callsFrom(cg, 'run')).toEqual([]);
    } finally {
      cg.close();
    }
  });
});

describe('Swift: a static call among overloads in a type and its extensions', () => {
  let cg: CodeGraph;
  beforeAll(async () => {
    const root = makeProject('cg-swift-static-overloads-', {
      // The type in one module, an overload of its member in another module's extension.
      'Sources/Kit/Cache.swift': `public enum Cache {
    public static func entryNames(inPackage package: Int) -> [String] { [] }
}
public enum Store {
    public static func load(path: Int) {}
}
`,
      'Sources/App/Cache+Descriptor.swift': `extension Cache {
    static func entryNames(descriptor: Int) -> [String] { [] }
}
`,
      'Sources/App/Store+Name.swift': `extension Kit.Store {
    static func load(name: String) {}
}
`,
      'Sources/App/Use.swift': `func useDescriptor() { _ = Cache.entryNames(descriptor: 1) }
func usePackage() { _ = Cache.entryNames(inPackage: 1) }
func useName() { Store.load(name: "") }
func useTag() { _ = Cache.entryNames(tag: 1) }
`,
      // Another module's copy of Cache, with an extension of its own.
      'Plugins/Other/Cache.swift': `enum Cache {
    static func entryNames(inPackage package: Int) -> [String] { [] }
}
`,
      'Plugins/Other/Cache+Tag.swift': `extension Cache {
    static func entryNames(tag: Int) -> [String] { [] }
}
`,
    });
    roots.push(root);
    cg = await CodeGraph.init(root, { index: true });
  });
  afterAll(() => cg?.close());

  it("resolves to the extension's overload whose argument labels the call writes", () => {
    expectQualified(onlyCall(cg, 'useDescriptor', 'Sources/App/Cache+Descriptor.swift:Cache::entryNames'));
  });

  it("resolves to the type's own overload, not another module's copy of it", () => {
    expectQualified(onlyCall(cg, 'usePackage', 'Sources/Kit/Cache.swift:Cache::entryNames'));
  });

  it('resolves to the overload a module-qualified extension adds', () => {
    // `extension Kit.Store` names the same type as `enum Store` in Sources/Kit.
    expectQualified(onlyCall(cg, 'useName', 'Sources/App/Store+Name.swift:Store::load'));
  });

  it("never moves to an overload another module's copy of the type declares", () => {
    // Only Plugins/Other's extension spells `tag:`, and it extends that module's Cache.
    expect(callsFrom(cg, 'useTag').filter((c) => c.target.startsWith('Plugins/'))).toEqual([]);
  });
});

describe('Swift: a static call the type does not declare as a method', () => {
  let cg: CodeGraph;
  beforeAll(async () => {
    const root = makeProject('cg-swift-static-declined-', {
      'Sources/Store/Predicate.swift': `indirect enum Pred {
    case isTrue
    case literal(Pred)
}
`,
      // A method of Pred with a local function named like the case.
      'Sources/Store/Schema.swift': `extension Pred {
    func sql() -> String { Self.render(self) }
    private static func render(_ p: Pred) -> String {
        func literal(_ v: Int) -> String { String(v) }
        return literal(1)
    }
}
`,
      'Tests/StoreTests/PredTests.swift': `func usePred() { _ = Pred.literal(.isTrue) }
`,
      // A project type named like CryptoKit's SHA256.
      'Sources/Kernel/SHA256.swift': `public enum SHA256 {
    public static func hash(_ bytes: [UInt8]) -> [UInt8] { bytes }
}
`,
      'Sources/App/Digest.swift': `import CryptoKit
import Foundation
func digest(_ d: Data) { _ = SHA256.hash(data: d) }
`,
    });
    roots.push(root);
    cg = await CodeGraph.init(root, { index: true });
  });
  afterAll(() => cg?.close());

  it("gives no calls edge to a local function of one of the type's methods", () => {
    // `literal` here is a case of Pred (not this feature's target); `render`'s
    // local `literal` is no member of Pred.
    expect(callsFrom(cg, 'usePred').filter((c) => c.target.includes('::render::'))).toEqual([]);
  });

  // The grammar (tree-sitter-swift 0.7.3, S-29) can end a method late and
  // index the type's later members under it (`Receiver::restore::receivedFacts`),
  // the same shape as a local function. Such a candidate is declined.
  it.todo("resolves a static call to a member the grammar indexes under an earlier method, once extraction indexes it on its type");

  // Known limit: the receiver is CryptoKit's SHA256 (imported), but a project
  // type shares its name, and an argument-label mismatch alone does not drop
  // the project's member. Imports are not consulted.
  it.fails("gives no calls edge to a project type that shares an imported SDK type's name", () => {
    expect(callsFrom(cg, 'digest')).toEqual([]);
  });

  // Known limit: a type declared once and aliased under its own name in
  // another file (`typealias X = Kit.X`) ties with the alias, so the call gets no edge.
  it.todo('resolves on the declaration when an alias of the same name ties with it');
});

describe("Swift: a static call through a type's supertypes", () => {
  let cg: CodeGraph;
  beforeAll(async () => {
    const root = makeProject('cg-swift-static-supertypes-', {
      // A nested type's inheritance clause belongs to the nested type, not to User.
      'Sources/App/String+X.swift': `extension String { static func x() {} }
`,
      'Sources/App/User.swift': `struct User {
    enum CodingKeys: String, CodingKey { case name }
}
func caller() { User.x() }
`,
      // `Kit.Runner` names the nested protocol; the enum Kit is no supertype of Q.
      'Sources/App/Kit.swift': `enum Kit {
    static func foo() {}
    protocol Runner {}
}
`,
      'Sources/App/Q.swift': `struct Q: Kit.Runner {}
func c2() { Q.foo() }
`,
      'Sources/App/Kit+Run.swift': `extension Kit.Runner { static func run() {} }
func c7() { Q.run() }
`,
      // The project declares no View2; it only extends it.
      'Sources/App/View2+Y.swift': `extension View2 { static func y() {} }
`,
      'Sources/App/HV.swift': `struct HV: View2 {}
func c3() { HV.y() }
`,
      'Sources/App/Deep.swift': `protocol P {}
extension P { static func deep() {} }
protocol P2: P {}
struct S: P2 {}
func c4() { S.deep() }
`,
      'Sources/App/Retro.swift': `protocol R {}
extension R { static func z() {} }
struct T {}
extension T: R {}
func c5() { T.z() }
`,
      'Sources/App/Classes.swift': `class Base { class func make() -> Base { Base() } }
class Mid: Base {}
final class Leaf: Mid {}
func c6() { _ = Leaf.make() }
`,
    });
    roots.push(root);
    cg = await CodeGraph.init(root, { index: true });
  });
  afterAll(() => cg?.close());

  it("gives no calls edge through a nested type's inheritance clause", () => {
    // `String` is CodingKeys' raw type, not a supertype of User.
    expect(callsFrom(cg, 'caller').filter((c) => c.target.startsWith('Sources/App/String+X.swift:'))).toEqual([]);
  });

  it('gives no calls edge to a member of the namespace a module-qualified conformance names', () => {
    expect(callsFrom(cg, 'c2').filter((c) => c.target.startsWith('Sources/App/Kit.swift:'))).toEqual([]);
  });

  it('resolves a member an extension adds to a protocol the project does not declare', () => {
    expectQualified(onlyCall(cg, 'c3', 'Sources/App/View2+Y.swift:View2::y'));
  });

  it("resolves a member a protocol's own parent protocol supplies", () => {
    expectQualified(onlyCall(cg, 'c4', 'Sources/App/Deep.swift:P::deep'));
  });

  it('resolves a member supplied by a conformance an extension declares', () => {
    expectQualified(onlyCall(cg, 'c5', 'Sources/App/Retro.swift:R::z'));
  });

  it("resolves a class member two levels up the class chain", () => {
    expectQualified(onlyCall(cg, 'c6', 'Sources/App/Classes.swift:Base::make'));
  });

  // Known limit: the extraction records `Kit.Runner` as `Kit`, so the walk
  // never reaches the protocol, and Q.run() gets no edge.
  it.fails("resolves a member a module-qualified conformance's extension supplies", () => {
    expectQualified(onlyCall(cg, 'c7', 'Sources/App/Kit+Run.swift:Runner::run'));
  });
});

describe('Swift: a static call through a qualified conformance or a raw type', () => {
  let cg: CodeGraph;
  beforeAll(async () => {
    const root = makeProject('cg-swift-static-qualified-', {
      // A class namespace nesting a protocol: `Kit.Runner` names the protocol,
      // and the class Kit is no supertype of Q.
      'Sources/App/ClassKit.swift': `class Kit {
    static func foo() {}
    protocol Runner {}
}
`,
      'Sources/App/QK.swift': `struct QK: Kit.Runner {}
func classNsCaller() { QK.foo() }
`,
      // The same entry on a class: the index holds `QC extends Kit` exactly as for `class QC: Kit`.
      'Sources/App/QC.swift': `class QC: Kit.Runner {}
func classOnClassCaller() { QC.foo() }
`,
      // A type the project only extends, nesting a protocol: `Ext.Runner` names the protocol.
      'Sources/App/Ext+Runner.swift': `extension Ext {
    static func bar() {}
    protocol Runner {}
}
`,
      'Sources/App/QE.swift': `struct QE: Ext.Runner {}
func extNsCaller() { QE.bar() }
`,
      // A protocol whose parent is a qualified entry: the index holds `QP extends Kit`.
      'Sources/App/QP.swift': `protocol QP: Kit.Runner {}
struct QS: QP {}
func protoParentCaller() { QS.foo() }
`,
      // A class-constrained protocol: Swift makes every conformer subclass Plain,
      // so the conformer's own superclass entry reaches Plain's members.
      'Sources/App/Plain.swift': `class Plain { static func plainFoo() {} }
protocol PlainP: Plain {}
class PlainC: Plain, PlainP {}
func classConstraintCaller() { PlainC.plainFoo() }
`,
      // A real superclass is walked whatever it nests: an enum or a protocol.
      'Sources/App/Bases.swift': `class EnumBase {
    enum Kind { case a }
    class func make() {}
}
class EnumLeaf: EnumBase {}
func enumBaseCaller() { EnumLeaf.make() }
class ProtoBase {
    protocol Delegate {}
    class func build() {}
}
class ProtoLeaf: ProtoBase {}
func protoBaseCaller() { ProtoLeaf.build() }
`,
      // An enum's raw type the project only extends: String is K's raw type, not its supertype.
      'Sources/App/String+RawX.swift': `extension String { static func rawX() {} }
`,
      'Sources/App/K.swift': `enum K: String { case a }
func rawCaller() { K.rawX() }
`,
    });
    roots.push(root);
    cg = await CodeGraph.init(root, { index: true });
  });
  afterAll(() => cg?.close());

  it('gives no calls edge to a member of the class namespace a module-qualified conformance names', () => {
    // The supertype edges QK's inheritance clause gave, shown when the call lands on Kit.
    const qk = cg.getNodesByName('QK').filter((n) => n.language === 'swift' && n.kind === 'struct');
    const supers = cg
      .getOutgoingEdgesFrom(qk.map((n) => n.id), ['extends', 'implements'])
      .map((e) => ({ kind: e.kind, target: cg.getNode(e.target)?.qualifiedName, targetKind: cg.getNode(e.target)?.kind }));
    expect(
      callsFrom(cg, 'classNsCaller').filter((c) => c.target.startsWith('Sources/App/ClassKit.swift:')),
      JSON.stringify(supers),
    ).toEqual([]);
  });

  // Known limit: the extraction keeps a qualified inheritance entry's first
  // segment, so `class QC: Kit.Runner` is indexed exactly as `class QC: Kit` and Kit's foo is taken.
  it.fails('gives no calls edge to a member of the class namespace a qualified superclass entry names', () => {
    expect(callsFrom(cg, 'classOnClassCaller').filter((c) => c.target.startsWith('Sources/App/ClassKit.swift:'))).toEqual([]);
  });

  // Known limit: the extraction keeps a qualified entry's first segment, so `struct QE: Ext.Runner`
  // is indexed as `struct QE: Ext`, the same as a conformance to a type the project only extends.
  it.fails('gives no calls edge to a member of an extended-only namespace a qualified conformance names', () => {
    expect(callsFrom(cg, 'extNsCaller').filter((c) => c.target.startsWith('Sources/App/Ext+Runner.swift:'))).toEqual([]);
  });

  it("gives no calls edge to a member of the class namespace a protocol's qualified parent names", () => {
    expect(callsFrom(cg, 'protoParentCaller').filter((c) => c.target.startsWith('Sources/App/ClassKit.swift:'))).toEqual([]);
  });

  it("resolves a superclass member on a class-constrained protocol's conformer through its own superclass entry", () => {
    expectQualified(onlyCall(cg, 'classConstraintCaller', 'Sources/App/Plain.swift:Plain::plainFoo'));
  });

  it('resolves a member of a superclass that nests only an enum', () => {
    expectQualified(onlyCall(cg, 'enumBaseCaller', 'Sources/App/Bases.swift:EnumBase::make'));
  });

  it('resolves a member of a superclass that nests a protocol', () => {
    expectQualified(onlyCall(cg, 'protoBaseCaller', 'Sources/App/Bases.swift:ProtoBase::build'));
  });

  // Known limit: K's raw type `String` resolves to nothing (the project only
  // extends String), and the supertype walk cannot tell a raw type from a
  // conformance there, so `K.rawX()` lands on String's extension.
  it.fails("gives no calls edge to a member an extension adds to an enum's raw type", () => {
    expect(callsFrom(cg, 'rawCaller').filter((c) => c.target.startsWith('Sources/App/String+RawX.swift:'))).toEqual([]);
  });
});

/** The confidence a typed instance call `box.open()` resolves at. */
const BOX_OPEN_CONFIDENCE = 0.9;
