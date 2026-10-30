/**
 * A Swift call on a project enum's case with associated values, `E.bad(1)`,
 * lands on that case.
 *
 * A single capitalised receiver segment with a lowercase member, whose
 * receiver is a project enum declaring that case, resolves to a `calls` edge
 * onto the `enum_member` at confidence 0.9 with `resolvedBy: 'qualified-name'`.
 * The receiver follows the static-call rules: a bare nested enum only inside
 * its scope, and only a declaration in a SwiftPM module the caller can see.
 * A case is the enum's own: it is never reached through a supertype, and a
 * receiver that names no project type (`Result.failure`) gets no edge onto a
 * project enum's same-named case.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

interface Call {
  /** `<file>:<qualifiedName>` of the target. */
  target: string;
  kind: string;
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
      kind: node!.kind,
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

/** The call lands on an enum case, at confidence 0.9, by qualified name. */
function expectCaseCall(call: Call): void {
  expect(call.kind, JSON.stringify(call)).toBe('enum_member');
  expect(call.resolvedBy, JSON.stringify(call)).toBe('qualified-name');
  expect(call.confidence, JSON.stringify(call)).toBe(0.9);
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe("Swift: a call on a project enum's case", () => {
  let cg: CodeGraph;
  beforeAll(async () => {
    const root = makeProject('cg-swift-enum-case-', {
      'Sources/App/E.swift': `enum E: Error {
    case bad(Int)
    case failed(status: Int, body: String)
    case none
}
`,
      'Sources/App/Use.swift': `func f() throws { throw E.bad(1) }
func makeFailed() {
    let x = E.failed(status: 3, body: "")
    _ = x
}
`,
      'Sources/App/Outer.swift': `enum Outer {
    enum Inner { case deep(String) }
    static func g() -> Inner { Inner.deep("x") }
}
`,
      // `Inner` is bare here, outside Outer's scope.
      'Sources/App/Far.swift': `func far() { _ = Inner.deep("x") }
`,
    });
    roots.push(root);
    cg = await CodeGraph.init(root, { index: true });
  });
  afterAll(() => cg?.close());

  it('resolves a case with an associated value', () => {
    expectCaseCall(onlyCall(cg, 'f', 'Sources/App/E.swift:E::bad'));
  });

  it('resolves a case with a labelled payload', () => {
    expectCaseCall(onlyCall(cg, 'makeFailed', 'Sources/App/E.swift:E::failed'));
  });

  // Extraction records a `calls` reference only for a call_expression
  // (extractCall in src/extraction/tree-sitter.ts), so a bare member access
  // such as `throw E.none` gives the resolver nothing to resolve.
  it.todo('resolves a case without associated values, once extraction records a reference for a bare member access');

  it('resolves a case of a bare nested enum inside its scope', () => {
    expectCaseCall(onlyCall(cg, 'g', 'Sources/App/Outer.swift:Outer::Inner::deep'));
  });

  it('gives no calls edge to a nested enum named bare outside its scope', () => {
    expect(callsFrom(cg, 'far').filter((c) => c.target.endsWith('::deep'))).toEqual([]);
  });
});

describe('Swift: a case call on an enum several modules declare', () => {
  let cg: CodeGraph;
  const DECL = `public enum Err: Error { case bad(Int) }
`;
  beforeAll(async () => {
    const root = makeProject('cg-swift-enum-case-modules-', {
      'Sources/A/Err.swift': DECL,
      'Sources/B/Err.swift': DECL,
      'Sources/B/Use.swift': `func useB() throws { throw Err.bad(1) }
`,
    });
    roots.push(root);
    cg = await CodeGraph.init(root, { index: true });
  });
  afterAll(() => cg?.close());

  it("resolves to the caller's own module's case, not another module's", () => {
    expectCaseCall(onlyCall(cg, 'useB', 'Sources/B/Err.swift:Err::bad'));
  });
});

describe('Swift: a case call the receiver does not declare', () => {
  let cg: CodeGraph;
  beforeAll(async () => {
    const root = makeProject('cg-swift-enum-case-declined-', {
      // The project declares no `Result`; `Result.failure` is the SDK's.
      'Sources/App/Other.swift': `enum Other { case failure(Int) }
enum MyErr: Error { case x(Int) }
func h() -> Result<Int, Error> { Result.failure(MyErr.x(1)) }
`,
      // Swift rejects a struct inheriting an enum; the grammar parses it.
      'Sources/App/Base.swift': `enum Base { case a(Int) }
struct Leaf: Base {}
func k() { _ = Leaf.a(1) }
`,
      'Sources/App/Root.swift': `class Root {
    enum Kind { case a(Int) }
}
class Leaf2: Root {}
func k2() { _ = Leaf2.a(1) }
`,
      // Module A's enum P and module B's protocol P share the path `P`, so
      // the case P::x's owner matches the protocol in S's supertype chain.
      'Sources/A/P.swift': `public enum P { case x(Int) }
`,
      'Sources/B/P.swift': `public protocol P {}
`,
      'Sources/B/S.swift': `struct S: P {}
func useS() { _ = S.x(1) }
`,
    });
    roots.push(root);
    cg = await CodeGraph.init(root, { index: true });
  });
  afterAll(() => cg?.close());

  it("gives no calls edge to a project enum's same-named case for an SDK receiver", () => {
    expect(callsFrom(cg, 'h').filter((c) => c.target.endsWith(':Other::failure'))).toEqual([]);
  });

  it("gives no calls edge to a supertype's case", () => {
    expect(callsFrom(cg, 'k').filter((c) => c.target.endsWith(':Base::a'))).toEqual([]);
  });

  it("gives no calls edge to a case of an enum nested in a supertype", () => {
    expect(callsFrom(cg, 'k2').filter((c) => c.target.endsWith(':Root::Kind::a'))).toEqual([]);
  });

  it("gives no calls edge to a case of an enum whose path is a supertype protocol's", () => {
    expect(callsFrom(cg, 'useS').filter((c) => c.target.endsWith(':P::x'))).toEqual([]);
  });
});
