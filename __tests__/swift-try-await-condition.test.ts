/**
 * `if try await f() {` in Swift (#3212). tree-sitter-swift 0.7.3 read the
 * `{` that opens the body as a trailing closure on `f(…)`: the condition
 * became an ERROR node, the enclosing method could run past its own closing
 * brace with the next member indexed inside it, and calls were recorded
 * under names made of source text (`await best(h) { r += 1 }`). 0.7.4 parses
 * it; both engines are built from it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages, getParser } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult, Node } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

/** The issue's larger sample: the condition spans two lines. */
const KIT = `struct Kit {
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

/** The issue's smaller sample. */
const SMALL = `struct Kit {
    func restore() {
        if try await best(h) { r += 1 }
        try await cas()
    }
    func received() {
    }
}
`;

/** The other conditions the issue names, and a call wrapped in Swift 6.2's `unsafe`. */
const OTHERS = `func load() async throws {
    if try await fetch() { go() }
    while try await next() { step() }
    if let v = try await load(x) { use(v) }
    let p = unsafe pointer.advanced(by: 1)
    unsafe Foo.make().bar()
}
`;

/** KIT with a comment between `try` and `await`; same line numbers (the fork's S-29 pin, swift-method-range). */
const KIT_COMMENT = `struct Kit {
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

/** The shape the fork's S-29 pin came from: restorePending closes on line 19, received is lines 21-23. */
const RESTORE_PENDING = `struct Kit {
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

/** `if try f(x) {` and `if await f(x) {`: they parsed under 0.7.3 too (the control). */
const TRY_OR_AWAIT_ALONE = `struct Kit {
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
  const parents = result.edges.filter((e) => e.kind === 'contains' && e.target === received.id).map((e) => e.source);
  expect(parents).toEqual([kit!.id]);
}

/** The condition's call is still a call reference from the method that makes it. */
function expectCallFrom(result: ExtractionResult, from: Node, callee: string): void {
  const refs = result.unresolvedReferences.filter((r) => r.referenceName === callee && r.referenceKind === 'calls');
  expect(refs.map((r) => r.fromNodeId)).toContain(from.id);
}

describe('Swift: `if try await f() {` parses (#3212)', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['swift']);
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

  function extract(backend: 'kernel' | 'wasm', source: string): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource('Kit.swift', source, 'swift');
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract('Kit.swift', source, 'swift');
    // A file with a parse error defers to the wasm extractor: this one has none.
    expect(result, 'kernel extraction').not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  it('parses every sample without an error', () => {
    for (const source of [KIT, SMALL, OTHERS]) {
      const tree = getParser('swift')!.parse(source)!;
      expect(tree.rootNode.hasError, source).toBe(false);
    }
  });

  it.each(backends)('keeps each method to its own lines and the calls to their names: %s', (backend) => {
    for (const [source, restoreEnd, receivedLines] of [[KIT, 8, [9, 10]], [SMALL, 5, [6, 7]]] as const) {
      const result = extract(backend, source);
      const methods = result.nodes
        .filter((n) => n.kind === 'method' || n.kind === 'function')
        .map((n) => `${n.kind} ${n.qualifiedName} ${n.startLine}-${n.endLine}`)
        .sort();
      expect(methods).toEqual([`method Kit::received ${receivedLines[0]}-${receivedLines[1]}`, `method Kit::restore 2-${restoreEnd}`]);
      const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName).sort();
      expect(calls).toEqual(['best', 'cas']);
    }
  });

  it.each(backends)('reads the calls in the other conditions, and through `unsafe`: %s', (backend) => {
    const calls = extract(backend, OTHERS).unresolvedReferences
      .filter((r) => r.referenceKind === 'calls')
      .map((r) => r.referenceName)
      .sort();
    // `unsafe Foo.make().bar()` is `(unsafe Foo.make()).bar()`: the chain is read through the wrapper.
    expect(calls).toEqual(['Foo.make', 'Foo.make().bar', 'fetch', 'go', 'load', 'next', 'pointer.advanced', 'step', 'use']);
  });

  it.each(backends)('a comment between `try` and `await` does not hide the pair: %s', (backend) => {
    const result = extract(backend, KIT_COMMENT);
    const restore = byQualifiedName(result, 'Kit::restore');
    expect(restore.endLine).toBe(8);
    expectReceivedIsStructMember(result);
    expectCallFrom(result, restore, 'best');
  });

  it.each(backends)('the restorePending shape keeps received a member of Kit: %s', (backend) => {
    const result = extract(backend, RESTORE_PENDING);
    const restore = byQualifiedName(result, 'Kit::restorePending');
    expect(restore.endLine).toBe(19);
    expectReceivedIsStructMember(result);
    expectCallFrom(result, restore, 'restoreBest');
  });

  it.each(backends)('`if try f(x) {` and `if await f(x) {` leave both methods their spans (control): %s', (backend) => {
    const result = extract(backend, TRY_OR_AWAIT_ALONE);
    const tryCond = byQualifiedName(result, 'Kit::tryCond');
    const awaitCond = byQualifiedName(result, 'Kit::awaitCond');
    expect(tryCond.endLine).toBe(4);
    expect(awaitCond.endLine).toBe(7);
    expectReceivedIsStructMember(result);
    expectCallFrom(result, tryCond, 'f');
    expectCallFrom(result, awaitCond, 'f');
  });
});
