/**
 * Regression pin: a Swift method whose `if` condition is `try await f(…)`
 * should keep its own span, the member declared after it should stay a member
 * of the type, and the call in the condition should be extracted from the
 * method that makes it.
 *
 * Under tree-sitter-swift 0.7.3 the first three cases fail, so they are
 * `it.fails`. That grammar reads the `{` after `if try await f(…)` as a
 * trailing closure on the call, so the condition becomes an ERROR node, and
 * in these shapes the parser's recovery takes the method's closing `}` with
 * it: the method's span runs on to the type's closing brace and the next
 * member nests inside it (`Kit::restore::received`, a function, instead of
 * the method `Kit::received`). tree-sitter-swift 0.7.4 parses them, so on
 * that grammar bump their bodies pass, `it.fails` reports each as a failure,
 * and the three flip to plain `it`.
 * `if try f(x) {` and `if await f(x) {` parse cleanly under 0.7.3 and are the
 * control, a plain `it` that passes now.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import type { ExtractionResult, Node } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

/** Lines are 1-based; each fixture's line numbers are noted beside it. */
const VECTOR_1 = `struct Kit {
    func restore() {
        for d in ds {
            if try await best(h, s: s,
                              n: n) { r += 1 }
        }
        _ = try await cas(p: a)
    }
    func received() {
    }
}
`;

/** VECTOR_1 with a comment between `try` and `await`; same line numbers. */
const VECTOR_1_COMMENT = `struct Kit {
    func restore() {
        for d in ds {
            if try /*c*/ await best(h, s: s,
                              n: n) { r += 1 }
        }
        _ = try await cas(p: a)
    }
    func received() {
    }
}
`;

const VECTOR_2 = `struct Kit {
    private func restorePending(_ handle: Handle, storage: any Storage,
                                            checkpoints: Checkpoints, limit: Int, stamp: Clock, now: Date,
                                            policies: Policies) async throws -> Int {
        let stream = StreamID(rawValue: "pending")
        let job = JobID(rawValue: "cursor")
        let prior = try await checkpoints.read(id: job, stream: stream)
        let after = prior.flatMap { String(data: $0, encoding: .utf8) }.flatMap { $0.isEmpty ? nil : $0 }
        let page = try await Store(storage: storage).pendingItems(after: after, limit: limit)
        var restored = 0
        for key in page.items {
            try Task.checkCancellation()
            if try await restoreBest(handle, storage: storage, key: key,
                                             excluding: nil, policies: policies, now: now) { restored += 1 }
        }
        _ = try await checkpoints.compareAndSwap(id: job, stream: stream, expected: prior,
            payload: page.last.map { Data($0.utf8) } ?? Data(), stamp: stamp)
        return restored
    }

    func received() -> Int {
        return 1
    }
}
`;

const VECTOR_3 = `struct Kit {
    func tryCond() {
        if try f(x) { n += 1 }
    }
    func awaitCond() async {
        if await f(x) { n += 1 }
    }
    func received() {
    }
}
`;

function extract(source: string): ExtractionResult {
  return extractFromSource('Sources/App/Kit.swift', source, 'swift');
}

function byQualifiedName(result: ExtractionResult, qn: string): Node {
  const node = result.nodes.find((n) => n.qualifiedName === qn);
  expect(node, `node ${qn}; got ${result.nodes.map((n) => `${n.kind} ${n.qualifiedName}`).join(', ')}`).toBeDefined();
  return node!;
}

/** The later member is a method of the struct, not nested in the method before it. */
function expectReceivedIsStructMember(result: ExtractionResult): void {
  const nested = result.nodes.filter((n) => n.name === 'received' && n.qualifiedName.includes('::restore'));
  expect(nested.map((n) => `${n.kind} ${n.qualifiedName}`)).toEqual([]);

  const received = byQualifiedName(result, 'Kit::received');
  expect(received.kind).toBe('method');

  const kit = result.nodes.find((n) => n.qualifiedName === 'Kit' && n.kind === 'struct');
  expect(kit).toBeDefined();
  const parents = result.edges
    .filter((e) => e.kind === 'contains' && e.target === received.id)
    .map((e) => e.source);
  expect(parents).toEqual([kit!.id]);
}

/** The condition's call is still a call reference from the method that makes it. */
function expectCallFrom(result: ExtractionResult, from: Node, callee: string): void {
  const refs = result.unresolvedReferences.filter(
    (r) => r.referenceName === callee && r.referenceKind === 'calls'
  );
  expect(refs.map((r) => r.fromNodeId)).toContain(from.id);
}

describe('Swift `if try await f(…) {` condition', () => {
  // tree-sitter-swift 0.7.3 parses `if try await f(…) {` as a trailing closure; fixed on the grammar's main branch, not yet released
  it.fails('a multi-line try-await condition inside a for loop leaves the method its own span', () => {
    const result = extract(VECTOR_1);
    const restore = byQualifiedName(result, 'Kit::restore');
    // restore's closing brace is line 8; received is lines 9-10.
    expect(restore.endLine).toBe(8);
    expectReceivedIsStructMember(result);
    expectCallFrom(result, restore, 'best');
  });

  // tree-sitter-swift 0.7.3 parses `if try await f(…) {` as a trailing closure; fixed on the grammar's main branch, not yet released
  it.fails('a comment between `try` and `await` does not hide the pair', () => {
    const result = extract(VECTOR_1_COMMENT);
    const restore = byQualifiedName(result, 'Kit::restore');
    // restore's closing brace is line 8; received is lines 9-10.
    expect(restore.endLine).toBe(8);
    expectReceivedIsStructMember(result);
    expectCallFrom(result, restore, 'best');
  });

  // tree-sitter-swift 0.7.3 parses `if try await f(…) {` as a trailing closure; fixed on the grammar's main branch, not yet released
  it.fails('the restorePending shape keeps received a member of Kit', () => {
    const result = extract(VECTOR_2);
    const restore = byQualifiedName(result, 'Kit::restorePending');
    // restorePending closes on line 19; received is lines 21-23.
    expect(restore.endLine).toBe(19);
    expectReceivedIsStructMember(result);
    expectCallFrom(result, restore, 'restoreBest');
  });

  it('`if try f(x) {` and `if await f(x) {` conditions leave both methods their spans (control)', () => {
    const result = extract(VECTOR_3);
    const tryCond = byQualifiedName(result, 'Kit::tryCond');
    const awaitCond = byQualifiedName(result, 'Kit::awaitCond');
    expect(tryCond.endLine).toBe(4);
    expect(awaitCond.endLine).toBe(7);
    expectReceivedIsStructMember(result);
    expectCallFrom(result, tryCond, 'f');
    expectCallFrom(result, awaitCond, 'f');
  });
});
