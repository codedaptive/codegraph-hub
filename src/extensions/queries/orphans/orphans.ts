/**
 * Orphans: symbols a branch ADDED that nothing in the index uses.
 *
 * ADDED (the ruling). A symbol S in the index (the HEAD / working-tree index)
 * is added since merge-base(base, HEAD) when, for S's file in
 * `changedFiles(root, base)` (`../blast/diff.ts`): the merge base of base and
 * HEAD diffed to the working tree (`<base>...HEAD` plus uncommitted changes):
 *   1. the file's status is `added`; or
 *   2. S's declaration line (`start_line`) lies inside one of the file's
 *      post-image changed ranges, or the file is modified or renamed with NO
 *      ranges (a binary notice under `-diff`, a mode-only change, a pure
 *      rename) and so is treated as changed throughout,
 *      every candidate in it passing this half; AND S's name does not occur as
 *      a whole word anywhere in the file's pre-image, read with
 *      `git show <mergeBaseSha>:./<oldPath ?? path>` from the project root
 *      (one read per modified or renamed file that has a candidate). A name
 *      present in the pre-image means the declaration was edited (signature
 *      change, moved within the file, a rename or a mode change with no text
 *      change), not added.
 * Consequences: a function moved to another file counts as added in the new
 * file (its callers usually keep it off the list); an added overload of an
 * existing name is NOT added (its name is in the pre-image), an accepted false
 * negative. A pre-image that cannot be read is counted in `preImageUnread`, and
 * that file's candidates are taken as added by the range test alone (for a
 * file with no ranges, as added outright). `runOrphans` refuses modified or
 * renamed files whose hunk ranges could not be read before reaching this check.
 *
 * Only declaration kinds are checked (`CANDIDATE_KINDS`): variables, constants,
 * fields and properties are not, because reads of them are under-edged in the
 * index and most would be false orphans.
 *
 * ORPHAN RULE. Incoming edges of every kind except `contains` and `exports`
 * count as uses, minus those whose source is inside S (recursion, nested
 * closures). A source is INSIDE S (the own-span test) when it is S, or S is
 * its ancestor over `contains` edges (walked up, every level fetched once), or
 * it is in S's file and its (line, column) span lies inside S's, comparing
 * start and end by line, then column. The ancestry half covers a nested
 * function whose indexed end column is only its signature's (Dart): its
 * `contains` parent is still S. Two declarations on one line, neither
 * containing the other, are siblings, so a one-line `caller` of a one-line
 * `target` is a use of `target`. For a Swift type, the uses of the nodes of its
 * same-name group count (a Swift `extension X` is a node of its own), joining
 * only nodes whose full type path matches (see "Swift grouping" below). Other
 * languages count only S's own uses; unrelated same-named types do not share
 * uses. When every counted use is a guess, S
 * is listed as "orphaned unless the guess is right", with the guessed edges.
 * Having no counted use is a suspicion, not a finding (the resolver misses
 * cross-crate calls and many Swift type uses), so two checks run before S is
 * called orphaned, in this order:
 *   - unresolved-reference check: the FAILED `unresolved_refs` rows whose
 *     `name_tail` equals S's name (a batched `name_tail IN (...)` lookup for
 *     every suspect), minus rows whose from-node is inside S (the own-span
 *     test above: S itself, a `contains` descendant, or inside S's span in
 *     S's file by line and column), and minus rows from another language than S's
 *     (the same-language rule: `unresolved_refs.language` against
 *     `nodes.language`, the JS family counting as one language; a Swift
 *     `close()` call is no evidence for a Python `close`). Any left: S is
 *     guessed, with them as `unresolved` evidence, most telling first: rows
 *     whose qualifier (the name before the last `.` / `::`) ends with the name
 *     of a type containing S, then rows from S's own file, then the rest, each
 *     by path and line. The entry keeps the first `EVIDENCE_KEPT` of them and
 *     `unresolvedCount` counts all of them;
 *   - text-mention check (the `rg -w` step a reader would run): for the
 *     suspects the unresolved-reference check left, one word-bounded search of
 *     every indexed file for their names, in batches sized by pattern length
 *     (`mentionBatches`), through grep-by-symbol's search stage,
 *     `searchIndexText`. A hit on a line outside S's own span, in S's own file
 *     or in any other file, makes S guessed, with the hits as `mentions`
 *     evidence.
 *     The hits of a name are held once per name (the distinct lines, by path),
 *     whatever number of suspects share it; each suspect's `mentionCount` is
 *     the distinct hit lines outside its own span and its `mentions` the first
 *     `EVIDENCE_KEPT` of them by path then line. That own-span test is by line
 *     alone: the search reports lines, not columns, so a hit on a line S's span
 *     only starts or ends on counts as inside S (a limit; a sibling on S's last
 *     line is not told apart from S).
 *     Comments and strings count: the list is "orphaned unless the guess is
 *     right". A name that is not an identifier (a Swift operator such as `==`)
 *     is not searched. The names go to the search in batches whose pattern
 *     fits in one ripgrep argument (`mentionBatches`, `mentionPatternBytes()`:
 *     16 KiB on Windows, `MENTION_PATTERN_BYTES` / 64 KiB elsewhere).
 *     A run keeps at most `MENTION_SEARCH_CAP` hits; when it drops some, its
 *     names still without a mention are searched again while that settles
 *     some, and a name a batched run cannot settle is searched alone, keeping
 *     `MENTION_SEARCH_CAP` hits plus as many as the largest own span of its
 *     suspects still without a mention can hold (one hit per line), so a run
 *     that still drops hits has kept one outside each of those spans.
 *     A name the check still cannot settle (its own run dropped hits and
 *     kept none outside, which only a file changing during the run can cause,
 *     or a name too long to pass to ripgrep) makes `findOrphans` throw
 *     `MentionSearchIncompleteError` rather than call it orphaned.
 *     `mentionCount` counts the hit lines the runs kept, so it can undercount. An
 *     indexed file the search cannot open (a path `searchablePaths` refuses,
 *     such as a missing, unreadable or out-of-project one; `searchIndexText`
 *     skips it and counts it in `truncated.files`) is not searched. The
 *     report's `searchUnread` is the most such files one run skipped: every
 *     run searches every indexed file, so the runs count the same files and are
 *     not summed. It is 0 when no run was needed. The text report prints it under
 *     the orphaned list.
 * ORPHANED therefore means: no counted incoming edge; no failed unresolved
 * reference with S's name from outside S in the same language (the JS family
 * counting as one language); and, for an identifier name only (operators such
 * as `==` are not searched), no word match outside S's own span in the files
 * the search could open (`searchUnread` counts the ones it could not).
 *
 * GUESS (the guess rule), per incoming edge, by its kind:
 *   - `calls`: resolution's shared questionable-edge predicate, exactly
 *     (`isCandidateEdge` in src/extensions/resolution/suspects.ts, whose SQL
 *     form `candidateEdgeSql` grep and blast use, so the three checks mark the
 *     same call edges): `resolvedBy` is `fuzzy` at any confidence; or
 *     `exact-match` when the caller's file differs from the edge's own target's
 *     file (a same-file exact match is the local definition, so it is certain;
 *     for a type the target may be another node of its same-name group, in
 *     another file than S's); or
 *     `instance-method` with a confidence below 0.9 (a missing confidence
 *     counts as 1).
 *   - every other counted kind (references, imports, extends, ...): the shared
 *     predicate is defined over `calls` only, and orphans counts every incoming
 *     kind but `contains` / `exports`, so these keep orphans' own rule, which
 *     reads the resolver's confidence rather than the files: `resolvedBy` is `fuzzy`; or
 *     `exact-match` with a numeric confidence below `CERTAIN_NAME_MATCH` (0.9;
 *     multi-candidate matches score 0.4 / 0.7); or any numeric confidence is
 *     below `LOW_CONFIDENCE` (0.7).
 * Any other edge is certain; under both rules that includes an edge with no
 * metadata (extraction-local, synthesized).
 *
 * EXCLUSIONS, checked in this order before the orphan rule and counted per
 * reason:
 *   - test (the test rule): the file matches the zone's `TEST_PATH`; or the name matches
 *     `TEST_NAME`; or S's declaration carries a test attribute of S's language
 *     (`testAttributeFor`). The attribute is read from the tree-sitter parse of
 *     the file (the grammar the indexer uses; one parse per Rust or Swift file
 *     the checks read, cached; `fileParse`), never from the text of a
 *     line: S's declaration node is found by its start position (row and
 *     column) and name. In a Rust file it is an outer `attribute_item` sibling
 *     right before the item (comments skipped, other attributes passed) whose
 *     path ends in `test` (`#[test]`, `#[tokio::test]`, `#[a::b::test]`) or
 *     `rstest`, however many lines the attribute spans; in a Swift file an
 *     `attribute` named `Test` among the declaration's `modifiers`; in any
 *     other language none. So a string, a trailing or doc comment, or an
 *     attribute that belongs to the item on the line above marks nothing.
 *     When the grammar cannot load, the parse misses its request-time budget,
 *     or the file cannot be read, that file falls back to the line walk
 *     (`hasAttribute`): S's start line, or a line just above it (walking up
 *     over attributes, comments and blanks, at most `ATTRIBUTE_LOOKBACK`
 *     lines), matches the language's attribute pattern, a comment line
 *     (`COMMENT_LINE`: `//`, `///`, `/*` or `*` first) walked over and never
 *     matched. The fallback is the text heuristic it always was: a line holding
 *     `"#[test]"` in a string, or a one-line `#[test] fn a() {}` above
 *     `fn b() {}`, can mark the wrong symbol there.
 *     Nested in a test (the nested-in-test rule): S's span lies inside another symbol of the same
 *     file that is a test by name or attribute (a helper type and its impl
 *     declared inside a `#[test]` fn: an inherent impl records no conformance,
 *     and a trait impl's methods reach the implementation rules only through an
 *     indexed trait or a listed external one, so this rule covers the rest); or,
 *     in a Rust file, inside a `mod` whose declaration carries `#[cfg(test)]`.
 *     Rust modules are not nodes, so that module's extent is read from the
 *     same tree-sitter Rust parse (`parseRust`, read through `fileParse`:
 *     strings and comments are what the parser says they are, and a comment inside the attribute's
 *     argument list (`cfg(test` then a block comment, then `)`) is ignored);
 *   - entry (the entry-point rule): a top-level `function` named `main` (no
 *     function or method holds it); a Swift type whose declaration carries
 *     `@main` (an `attribute` named `main` among its `modifiers` in the Swift
 *     parse, the line-walk fallback when there is none, as for the test rule;
 *     `@main` in any other language marks nothing); a method or
 *     function named `main` held by such a type; a top-level Go `function` named
 *     `init` (no function or method holds it); a Python `method` with a dunder
 *     name (`__len__`, `__eq__`, etc.); a Python module-level `function` named
 *     `__getattr__` or `__dir__` (PEP 562: no function, method or type holds it).
 *     The runtime calls these; nothing in the index does;
 *   - implementation, for a method or function S, in this order:
 *     Requirements (the requirement rule): S is held by an interface, trait or
 *     protocol node (a requirement, reached through its implementations, so it
 *     has no incoming edge of its own), and that container has a counted use;
 *     a guessed use counts here, since the requirement is only ever as dead as
 *     its container.
 *     Indexed conformances (the indexed-conformance check): S's containing
 *     type (via `contains`; only for Swift also every same-named type node of
 *     its proven type path, see "Swift grouping") reaches, over `implements` / `extends`
 *     edges up to `CONFORMANCE_DEPTH` hops, an indexed type T that contains an
 *     indexed member named S.name. Interface and abstract members are indexed
 *     `method` nodes held by their type in TypeScript, Rust, Java, C#, Kotlin,
 *     PHP, Go and Python, so a member node is the proof; a type with no member
 *     nodes proves nothing, and a comment or a string naming S.name never
 *     does. The one exception is a Swift `protocol` (an `interface` node of
 *     language swift), whose function requirements are not nodes: its
 *     requirement names are read from the protocol body in the Swift parse
 *     (`protocol_function_declaration` names, initializers as `init`,
 *     `protocol_property_declaration` names, subscripts as `subscript`), and
 *     S.name among them proves it. When that parse, or the protocol's declaration
 *     in it, is unavailable (no grammar, a parse past its budget, an unreadable
 *     file, no declaration at the protocol's position) the protocol proves
 *     NOTHING: its requirement set is unknown, and neither a comment nor any
 *     raw text of its span establishes an implementation. Nothing emits `overrides`
 *     edges, so they are not consulted. A TS / Rust implementation's
 *     synthesized `calls` edge from the interface member does not matter: this
 *     runs before the orphan rule.
 *     External conformances (the external-conformance table): when the
 *     containing type has failed `extends` / `implements` unresolved refs (a
 *     type the index did not resolve, usually one it does not hold), S is an implementation only when
 *     `EXTERNAL_REQUIREMENTS`, a HEURISTIC table of well-known requirement
 *     names, lists S.name for that type (looked up by own property only, so a
 *     type named `constructor` or `toString` is just an unlisted type);
 *     otherwise S stays listed with `externalConformances` naming them;
 *   - constructor (the constructor rule): S is named constructor / init / __init__ / new and its
 *     containing type has a counted use.
 *
 * SWIFT GROUPING. A Swift `extension X` is a node of its own, so a type's
 * uses and conformances are those of its whole group of same-named Swift type
 * nodes. The group joins only the nodes whose full type path is proven equal.
 * Every Swift type's path, a declaration's as well as an extension's, is read
 * from the Swift parse of its file (`qualified_name` is not used: it drops the
 * qualifier an extension was written with): the written type path, prefixed
 * with the path of the type or extension it is nested in, so `enum K { struct
 * Builder }` is `K.Builder` and `extension API.Outer { struct Inner }` is
 * `API.Outer.Inner`. So `A.Widget: Encodable` is not `B.Widget`'s conformance.
 * A type declared inside any code body joins nothing, including a type nested
 * in such a local type. Only type, protocol and extension declarations and their
 * bodies preserve a groupable path; compilation conditions (`#if`, `#elseif`,
 * `#else`) are transparent, so their branches still join.
 * A node whose path cannot be established (no Swift grammar, a parse past its
 * budget, an unreadable file, no declaration at its position) joins no other
 * node and keeps only itself: two unproven paths are never taken as equal.
 * Limit: a path names no module, so same-path types of two modules join. Other
 * languages do not group: unrelated same-named types do not share uses.
 *
 * SWIFT PARSE. A Swift file is parsed from the text the extractor parsed: the
 * extractor's own pre-parse transform (`joinSwiftCompositionContinuations`, a
 * protocol composition's line-leading `&` moved onto the line before) is
 * applied first, imported not copied. It keeps the line count and every
 * declaration's position (only the tokens of an `&` line, which starts no
 * declaration, move one column), so the indexed (row, column) of a node still
 * finds its declaration in the parse.
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getParser, loadGrammarsForLanguages } from '../../../extraction/grammars';
import { joinSwiftCompositionContinuations } from '../../../extraction/languages/swift';
import { parseWithinBudget } from '../../../extraction/parse-budget';
import type { BlastNode } from '../blast/blast';
import type { ChangedFile } from '../blast/diff';
import { isCandidateEdge } from '../../resolution/suspects';
import { TEST_PATH } from '../shared/test-path';
import type { FailedRef, IncomingUse, NodeDetail, OrphanNode, OrphansStore } from './store';

/** Node kinds checked for orphans: declarations a caller names. */
export const CANDIDATE_KINDS: ReadonlySet<string> = new Set([
  'function', 'method', 'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'type_alias', 'component', 'union',
]);

/**
 * The most `mentions` and the most `unresolved` references one guessed entry keeps (the counts
 * keep the full number). `render.ts`'s JSON cap is this same number.
 */
export const EVIDENCE_KEPT = 20;

/** Kinds that are a type: the containing-type, Swift-extension-grouping and conformance-target kinds. */
const TYPE_KINDS = ['class', 'struct', 'enum', 'protocol', 'interface', 'trait', 'union'] as const;
const TYPE_KIND_SET: ReadonlySet<string> = new Set(TYPE_KINDS);

/** Kinds the implementation exclusion applies to. */
const MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'function']);

/** Names the constructor exclusion applies to. */
const CONSTRUCTOR_NAMES: ReadonlySet<string> = new Set(['constructor', 'init', '__init__', 'new']);

/** Below this, a non-call edge is a guess (a call is judged by resolution's isCandidateEdge instead): 0.7 is the lowest common resolver tier (single-candidate file-path fallback and the like). */
export const LOW_CONFIDENCE = 0.7;
/** A non-call `exact-match` edge at or above this is a high-confidence name match, treated as certain (a call is judged by resolution's isCandidateEdge instead). */
export const CERTAIN_NAME_MATCH = 0.9;

/** Test-function naming conventions: `testFoo` / `test_foo` / `test1` (XCTest, Rust, Python), `TestFoo` (Go). */
const TEST_NAME = /^test[A-Z_0-9]|^Test[A-Z_]/;
/**
 * Rust's test attributes, read in Rust files only: `#[test]`, `#[tokio::test]` (any path ending in `test`), `#[rstest]`.
 * The line-walk fallback's pattern (`hasAttribute`); the Rust parse reads the attribute's path instead (`isRustTestAttribute`).
 */
const RUST_TEST_ATTRIBUTE = /#\[\s*(?:[A-Za-z_]\w*::)*test\b|#\[\s*rstest\b/;
/** Swift Testing's `@Test`, read in Swift files only. The line-walk fallback's pattern; the Swift parse reads the attribute's name. */
const SWIFT_TEST_ATTRIBUTE = /@Test\b/;
/**
 * The test rule's line-walk pattern for a file of `language` (the fallback when the file's
 * parse is unavailable): Rust's in a Rust file, Swift's in a Swift file, none in any other. So
 * a Java `@Test` annotation, a Python `@Test` decorator or a Python `#[test]` comment excludes
 * nothing (a test there is caught by `TEST_PATH` or `TEST_NAME`, or not at all).
 */
function testAttributeFor(language: string): RegExp | null {
  if (language === 'rust') return RUST_TEST_ATTRIBUTE;
  if (language === 'swift') return SWIFT_TEST_ATTRIBUTE;
  return null;
}
/** A line the attribute walk passes over: blank, an attribute, or a comment. */
const ATTRIBUTE_OR_COMMENT = /^\s*(?:$|#\[|@|\/\/|\/\*|\*)/;
/**
 * A comment line: `//` (and so `///`), `/*` or `*` first after whitespace. The attribute walk
 * passes over it but never reads it as an attribute, so `// @Test` or `/// #[test]` marks
 * nothing. A line inside a block comment that starts with none of these is not seen as a
 * comment.
 */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
/**
 * How many lines the attribute walk looks above a start line (test and entry
 * attributes, `hasAttribute`). 5 covers a doc comment line plus a few stacked attributes.
 */
const ATTRIBUTE_LOOKBACK = 5;

/**
 * Swift's program entry attribute (the entry-point rule), read in Swift files only, so a Python
 * `@main` decorator marks nothing. `\b` keeps `@mainActor`-style names out; `@MainActor` differs in case.
 * The line-walk fallback's pattern (`hasAttribute`); the Swift parse reads the attribute's name instead.
 */
const MAIN_ATTRIBUTE = /@main\b/;
/** The entry-point name (the entry-point rule): Rust / C-family `fn main`, Swift's `static func main()` on an `@main` type. */
const ENTRY_NAME = 'main';
/** The Go runtime calls a package's top-level `init` functions before `main`. */
const GO_INIT_NAME = 'init';
/** Python data-model methods called by the interpreter, not by indexed callers. */
const PYTHON_DUNDER = /^__[A-Za-z0-9_]+__$/;
/** Module-level Python runtime hooks (PEP 562). */
const PYTHON_MODULE_HOOKS: ReadonlySet<string> = new Set(['__getattr__', '__dir__']);
/** Kinds whose `main` or Go `init` is a local rather than a top-level entry point. */
const CALLABLE_KINDS: ReadonlySet<string> = new Set(['function', 'method']);

/** Container kinds whose members are requirements (the requirement rule). */
const REQUIREMENT_CONTAINER_KINDS: ReadonlySet<string> = new Set(['interface', 'trait', 'protocol']);

/**
 * The text-mention search's hit cap per batched run (`searchIndexText`'s `maxHits`); see the
 * header for what happens past it. The cap bounds what one run holds (the search holds at
 * most twice its `maxHits` at once); the names it cuts are searched again, so coverage does
 * not depend on the cap's size. A name searched alone gets `maxHits` = this + `own`, where
 * `own` is the largest `ownHitBound` among its suspects still without a mention: the
 * lines of that suspect's own span that contain the name, or every line of the span
 * as indexed when its file cannot be read. So that run holds at most
 * 2 * (MENTION_SEARCH_CAP + own) hits at once; `own` has no cap of its own.
 */
export const MENTION_SEARCH_CAP = 10_000;

/**
 * Bytes one text-mention pattern may take outside Windows (`mentionPatternBytes`).
 * `searchIndexText` hands the pattern to ripgrep as one argument (`-e <pattern>`),
 * and Linux refuses a single argument over 128 KiB (MAX_ARG_STRLEN) with E2BIG.
 * Half of that leaves room; it also sits well inside macOS's 1 MB cap on argv plus
 * environment beside grep's default path batches (200 KB).
 */
export const MENTION_PATTERN_BYTES = 64 * 1024;

/**
 * Windows limits the whole command line to 32,767 UTF-16 units. The runner passes
 * an 8 KiB path batch beside the pattern, executable path and other arguments.
 * UTF-8 bytes are at least the UTF-16 units of the same text, so this byte budget
 * also bounds that portion of the command line.
 */
const MENTION_PATTERN_BYTES_WIN32 = 16 * 1024;

/** The byte budget for one mention pattern on `platform` (the current platform by default). */
export function mentionPatternBytes(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? MENTION_PATTERN_BYTES_WIN32 : MENTION_PATTERN_BYTES;
}

/**
 * The text-mention check could not finish for a name, so `findOrphans` cannot call
 * that name's suspects orphaned: the name searched alone still dropped hits and kept
 * none outside one suspect's own span, so that suspect has no mention (only a file
 * changing during the run can cause it), or its pattern alone is over
 * `mentionPatternBytes()`. `runOrphans` reports it as a failure.
 */
export class MentionSearchIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MentionSearchIncompleteError';
  }
}

/** A name the text-mention check can word-search: identifier characters only. */
const IDENTIFIER_NAME = /^[\p{L}\p{N}_$]+$/u;

/**
 * The same-language rule's language key. One file's language is compared with S's; the JS family
 * (`.ts` calling a `.tsx` export, a `.vue` script calling a `.ts` one) is one
 * language here, since its files call each other all the time.
 */
const JS_FAMILY: ReadonlySet<string> = new Set(['typescript', 'javascript', 'tsx', 'jsx', 'vue', 'svelte', 'astro']);
const languageKey = (language: string): string => (JS_FAMILY.has(language) ? 'js' : language);

/**
 * The unresolved-reference check's rank of a failed reference for S: 0 when the reference's qualifier
 * (its name before the last `.` or `::`) ends, as a whole word, with the name
 * of a type containing S (`MootAICommand.run`, `self.cmd.MootAICommand.run`);
 * 1 when it is in S's own file; 2 otherwise.
 */
function refRank(referenceName: string, path: string, s: { path: string }, containerNames: readonly string[]): number {
  const cut = Math.max(referenceName.lastIndexOf('.'), referenceName.lastIndexOf('::'));
  if (cut > 0) {
    const qualifier = referenceName.slice(0, cut);
    for (const t of containerNames) {
      if (qualifier.endsWith(t) && !/[\p{L}\p{N}_$]/u.test(qualifier.charAt(qualifier.length - t.length - 1))) return 0;
    }
  }
  return path === s.path ? 1 : 2;
}

/**
 * How many `implements` / `extends` hops the indexed-conformance check follows.
 * A chain longer than this is not followed past this many hops, which caps the walk
 * on a very deep hierarchy. A cycle needs no bound: each type is visited once.
 */
const CONFORMANCE_DEPTH = 5;

/**
 * Requirement names of well-known types outside the index, per language, keyed
 * by the type's last path segment (generic arguments dropped). A HEURISTIC:
 * the index holds no node for these types, so their requirements cannot be
 * read, and this curated list covers the common conformances whose methods are
 * called only by the language runtime or a framework. A member of a type that
 * conforms to an external type not listed here, or under a name not listed,
 * stays reported with the conformance named so the reader can judge.
 */
const EXTERNAL_REQUIREMENTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  swift: {
    Hashable: ['hash', '=='],
    Equatable: ['=='],
    Comparable: ['<'],
    Encodable: ['encode'],
    Decodable: ['init'],
    Codable: ['encode', 'init'],
    CustomStringConvertible: ['description'],
    Identifiable: ['id'],
    // Error has no required members, so this entry excludes nothing; it is listed to record that Error was considered.
    Error: [],
  },
  rust: {
    Display: ['fmt'],
    Debug: ['fmt'],
    Default: ['default'],
    From: ['from'],
    TryFrom: ['try_from'],
    FromStr: ['from_str'],
    Drop: ['drop'],
    Iterator: ['next'],
    Clone: ['clone'],
    PartialEq: ['eq', 'ne'],
    PartialOrd: ['partial_cmp'],
    Ord: ['cmp'],
    Hash: ['hash'],
    Deref: ['deref'],
    DerefMut: ['deref_mut'],
    AsRef: ['as_ref'],
    Future: ['poll'],
    Serialize: ['serialize'],
    Deserialize: ['deserialize'],
    Error: ['source'],
  },
};

/**
 * The requirement names `EXTERNAL_REQUIREMENTS` lists for the external type `typeName` in
 * `language`, or undefined. Own properties only, at both levels: a type named `constructor`,
 * `toString`, `hasOwnProperty` or `__proto__` is an unlisted type, not an inherited function.
 */
function externalRequirements(language: string, typeName: string): readonly string[] | undefined {
  if (!Object.hasOwn(EXTERNAL_REQUIREMENTS, language)) return undefined;
  const table = EXTERNAL_REQUIREMENTS[language];
  if (!table || !Object.hasOwn(table, typeName)) return undefined;
  return table[typeName];
}

/** One listed symbol. `span` is `L<start>-L<end>`, as blast reports it. */
export interface OrphanEntry {
  id: string;
  name: string;
  kind: string;
  path: string;
  span: string;
  /** External types S's containing type conforms to (the external-conformance table), when S was not excluded by the table. */
  externalConformances?: string[];
}

/** A guessed incoming edge, as reported. */
export interface GuessEdge {
  source: string;
  sourceName: string;
  sourcePath: string;
  line: number;
  kind: string;
  resolvedBy: string | null;
  confidence: number | null;
}

/** A failed unresolved reference naming S (the unresolved-reference check), as reported. */
export interface UnresolvedEvidence {
  /** The reference as written (`other_crate::cross_target`). */
  name: string;
  /** `unresolved_refs.reference_kind` (`calls`, `references`, ...). */
  kind: string;
  path: string;
  line: number;
}

/** A line naming S outside S's own span (the text-mention check). */
export interface MentionEvidence {
  path: string;
  line: number;
}

/**
 * A listed symbol with the evidence that something may use it. `edges` holds
 * every guessed incoming edge, by source path then line; `unresolved` the
 * first `EVIDENCE_KEPT` of the failed references the unresolved-reference
 * check kept, most telling first (container-qualified, then S's own file, then
 * the rest, each by path and line: `refRank`); `mentions` the first
 * `EVIDENCE_KEPT` mention lines outside S's own span, by path then line, of the
 * lines the text-mention search kept (the search caps its hits, see the
 * header). `edgeCount` is the length of `edges`; `unresolvedCount` and
 * `mentionCount` are the full counts, which can exceed what an entry keeps
 * (`mentionCount` can still undercount the repo, as the search is capped).
 * The renderers cap what they print (`./render.ts`). A symbol is
 * put here by the first stage that finds evidence (edges, then the
 * unresolved-reference check, then the text-mention check), so the later
 * lists of an entry an earlier stage put here are empty.
 */
export interface GuessedEntry extends OrphanEntry {
  edges: GuessEdge[];
  unresolved: UnresolvedEvidence[];
  mentions: MentionEvidence[];
  edgeCount: number;
  unresolvedCount: number;
  mentionCount: number;
}

export interface OrphansReport {
  /** How many symbols the range added (every candidate, excluded or not). */
  added: number;
  orphans: OrphanEntry[];
  guessed: GuessedEntry[];
  excluded: { test: number; implementation: number; constructor: number; entry: number };
  /** Modified or renamed files whose pre-image could not be read. */
  preImageUnread: number;
  /**
   * Indexed files the text-mention search could not read, so a mention there would be
   * missed: the most any one search run skipped (see the header), 0 when none ran.
   */
  searchUnread: number;
}

/** One line a text search matched, by project-relative path. */
export interface TextHit {
  path: string;
  line: number;
  /** The matched line as the search reported it (possibly trimmed or cut); used only when the file cannot be read. */
  text: string;
}

/** What `findOrphans` reads besides the index: the pre-image and working-tree text of a file, and the text-mention search. */
export interface OrphansIO {
  /** The file's text at the merge base (`oldPath ?? path`), or null when it cannot be read. */
  preImage(file: ChangedFile): string | null;
  /** The file's current text, by project-relative path, or null when it cannot be read. */
  source(path: string): string | null;
  /**
   * Search every indexed file for the ripgrep regex `pattern`, keeping at most
   * `maxHits` hits, one per matching line (`findOrphans`' single-name runs rely
   * on that); `truncated` is true when hits past the cap were dropped; `unread`
   * counts the indexed files the search could not read.
   */
  search(pattern: string, maxHits: number): Promise<{ hits: TextHit[]; truncated: boolean; unread: number }>;
}

/**
 * True when an edge of `kind` carrying `metadata` (edges.metadata, parsed) is a
 * guess under the guess rule (see the header). A `calls` edge is a guess
 * exactly when resolution's `isCandidateEdge` holds for it, given the caller's
 * file `sourcePath` and the target's file `targetPath` (a same-file exact
 * match is certain); any other kind by orphans' own confidence rule, where
 * `fuzzy` is a guess whatever its confidence and the files are not read.
 */
export function isGuess(kind: string, metadata: Record<string, unknown>, sourcePath: string, targetPath: string): boolean {
  if (kind === 'calls') return isCandidateEdge(kind, metadata, sourcePath, targetPath);
  const by = metadata.resolvedBy;
  const c = metadata.confidence;
  const conf = typeof c === 'number' && Number.isFinite(c) ? c : null;
  if (by === 'fuzzy') return true;
  if (by === 'exact-match' && conf !== null && conf < CERTAIN_NAME_MATCH) return true;
  return conf !== null && conf < LOW_CONFIDENCE;
}

/** Characters that make up an identifier, for the whole-word tests. */
const IDENT = '[\\p{L}\\p{N}_$]';

/**
 * True when `name` occurs in `text` with no identifier character on either
 * side. Lookarounds rather than `\b`, so an operator name (`==`) or a `$` name
 * is tested the same way.
 */
export function containsWord(text: string, name: string): boolean {
  if (name === '') return false;
  // `-` is literal outside a character class; `\-` is an invalid escape under `u`.
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(?<!${IDENT})${escaped}(?!${IDENT})`, 'u').test(text);
}

function spanLines(span: string): { start: number; end: number } {
  const m = /^L(\d+)-L(\d+)$/.exec(span);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : { start: 0, end: 0 };
}

/** A type's last path segment with generic arguments dropped: `std::fmt::Display` → `Display`, `From<T>` → `From`. */
function lastSegment(ref: string): string {
  const bare = ref.replace(/<.*$/s, '').trim();
  const parts = bare.split(/::|\.|\//);
  return parts[parts.length - 1] ?? bare;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * An identifier (`IDENTIFIER_NAME`) escaped for both a JS `u` regex and a
 * ripgrep regex: `$` is its only metacharacter.
 */
function escapeName(name: string): string {
  return name.replace(/\$/g, '\\$');
}

/**
 * The text-mention check's ripgrep pattern: any of `names` with no identifier character on either
 * side (the line's start or end counts as a boundary). `names` must be
 * identifiers (`IDENTIFIER_NAME`).
 */
export function mentionPattern(names: readonly string[]): string {
  const id = '[^\\p{L}\\p{N}_$]';
  return `(?:^|${id})(?:${names.map(escapeName).join('|')})(?:${id}|$)`;
}

/**
 * `names`, in order, split into batches whose `mentionPattern` takes at most
 * `maxBytes` UTF-8 bytes (each name is costed with one `|` separator, so a
 * batch's pattern is a byte under its count). A name too long for a batch of
 * its own still gets one, so no batch is empty; `findOrphans` refuses to
 * search a name whose pattern alone is over `mentionPatternBytes()`.
 */
export function mentionBatches(names: readonly string[], maxBytes: number = mentionPatternBytes()): string[][] {
  const overhead = Buffer.byteLength(mentionPattern([]));
  const batches: string[][] = [];
  let cur: string[] = [];
  let bytes = overhead;
  for (const n of names) {
    const cost = Buffer.byteLength(escapeName(n)) + 1;
    if (cur.length > 0 && bytes + cost > maxBytes) {
      batches.push(cur);
      cur = [];
      bytes = overhead;
    }
    cur.push(n);
    bytes += cost;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/** A guessed entry; `counts` gives the full number of unresolved references or mentions when the lists kept fewer. */
function guessedEntry(
  entry: OrphanEntry,
  edges: GuessEdge[],
  unresolved: UnresolvedEvidence[],
  mentions: MentionEvidence[],
  counts: { unresolved?: number; mentions?: number } = {},
): GuessedEntry {
  return {
    ...entry, edges, unresolved, mentions,
    edgeCount: edges.length,
    unresolvedCount: counts.unresolved ?? unresolved.length,
    mentionCount: counts.mentions ?? mentions.length,
  };
}

/** Whether position `(aLine, aCol)` is at or before `(bLine, bCol)`: by line, then column. */
function atOrBefore(aLine: number, aCol: number, bLine: number, bCol: number): boolean {
  return aLine < bLine || (aLine === bLine && aCol <= bCol);
}

/**
 * Whether the span `inner` lies inside `outer` (a span holds itself), by line then column at
 * both ends: the own-span test. Two declarations on one line are siblings unless one's
 * span holds the other's.
 */
function spanInside(
  inner: { startLine: number; startColumn: number; endLine: number; endColumn: number },
  outer: { startLine: number; startColumn: number; endLine: number; endColumn: number },
): boolean {
  return (
    atOrBefore(outer.startLine, outer.startColumn, inner.startLine, inner.startColumn) &&
    atOrBefore(inner.endLine, inner.endColumn, outer.endLine, outer.endColumn)
  );
}

/** A comment node of the Rust grammar. */
const isRustComment = (n: SyntaxNode): boolean => n.type === 'line_comment' || n.type === 'block_comment';

/**
 * Whether a tree-sitter Rust `attribute_item` is exactly `#[cfg(test)]`: the path `cfg` and the
 * one argument `test`. A comment inside the argument list (a block comment after `test`, or before
 * it) is not an argument and is ignored.
 */
function isCfgTest(item: SyntaxNode): boolean {
  const attr = item.namedChild(0);
  if (attr?.type !== 'attribute') return false;
  const head = attr.namedChild(0);
  const args = attr.childForFieldName('arguments');
  const parts = args ? args.namedChildren.filter((c): c is SyntaxNode => c !== null && !isRustComment(c)) : [];
  const only = parts.length === 1 ? (parts[0] as SyntaxNode) : null;
  return head?.type === 'identifier' && head.text === 'cfg' && only?.type === 'identifier' && only.text === 'test';
}

/**
 * Whether a tree-sitter Rust `attribute_item` is a test attribute: its path (`test`,
 * `tokio::test`, `a::b::test`) ends in `test`, or is `rstest`. Arguments, on however many lines,
 * do not matter.
 */
function isRustTestAttribute(item: SyntaxNode): boolean {
  const attr = item.namedChild(0);
  if (attr?.type !== 'attribute') return false;
  const path = attr.namedChild(0);
  const last =
    path?.type === 'scoped_identifier' ? path.childForFieldName('name')?.text
    : path?.type === 'identifier' ? path.text
    : undefined;
  return last === 'test' || last === 'rstest';
}

/**
 * A declaration the parse found, by position (`row` 0-based, `col` as the index's start column):
 * what the attribute rules and the Swift grouping read. Only declarations those rules need are
 * kept: Rust items marked as tests; Swift functions and initializers with a `@Test` / `@main`
 * attribute, and every Swift type and protocol.
 */
interface Decl {
  row: number;
  col: number;
  name: string;
  /** A test attribute (Rust `#[test]`, `#[tokio::test]`, `#[rstest]`; Swift `@Test`). */
  test: boolean;
  /** Swift's `@main`. */
  main: boolean;
  /** A nonlocal Swift type, extension or protocol: its type path (an extension's as written, with the path of what contains it). */
  typePath?: string;
  /** A Swift `extension`. */
  extension?: boolean;
  /** A Swift protocol: the requirement names its body declares. */
  requirements?: Set<string>;
}

/** One file's parse, reduced to what the rules read, so the tree itself is freed at once. */
interface FileParse {
  /** Declarations by `<row>\0<name>`. */
  decls: Map<string, Decl[]>;
  /** The Rust `#[cfg(test)]` module ranges (1-based lines, attribute to closing brace), sorted. */
  cfgTest: { start: number; end: number }[];
}

function addDecl(decls: Map<string, Decl[]>, d: Decl): void {
  const key = `${d.row}\0${d.name}`;
  const at = decls.get(key);
  if (at) at.push(d);
  else decls.set(key, [d]);
}

/** The declarations at row `row` named `name`, narrowed to column `col` when it is known (null: any). */
function declsAt(fp: FileParse, row: number, col: number | null, name: string): Decl[] {
  return (fp.decls.get(`${row}\0${name}`) ?? []).filter((d) => col === null || d.col === col);
}

/** Load the grammar of `language`; false when it cannot be loaded. */
async function grammarReady(language: 'rust' | 'swift'): Promise<boolean> {
  try {
    await loadGrammarsForLanguages([language]);
    return getParser(language) !== null;
  } catch {
    return false;
  }
}

/** The parse of `source`, or null when the grammar is not loaded or the parse does not finish within the request-time budget. */
function parseTree(language: 'rust' | 'swift', source: string): ReturnType<typeof parseWithinBudget> {
  try {
    const parser = getParser(language);
    return parser ? parseWithinBudget(parser, source) : null;
  } catch {
    return null;
  }
}

/**
 * One Rust parse's reading: the items marked as tests and the `#[cfg(test)]` module ranges.
 * The grammar must be loaded (`grammarReady`); null when the parse fails.
 * A `#[cfg(test)]` range is a Rust inline module's 1-based lines, from the attribute to the
 * module's closing brace; the attribute is an outer one (an `attribute_item` sibling before
 * the `mod_item`, past other attributes and comments), and a comment inside its argument
 * list is ignored. The outer attributes are collected in one forward pass over each node's
 * children (`attribute_item`s pending across comments, dropped at any other child), so a
 * run of N comments costs O(N), not a walk back from every node. Not matched: a `#[cfg(test)] mod x;` (an out-of-line module, no body
 * here), an inner `#![cfg(test)]`, a compound `cfg(all(test, ...))`.
 */
function parseRust(source: string): FileParse | null {
  const tree = parseTree('rust', source);
  if (!tree) return null;
  try {
    const decls = new Map<string, Decl[]>();
    const cfgTest: { start: number; end: number }[] = [];
    const stack: SyntaxNode[] = [tree.rootNode];
    while (stack.length > 0) {
      const n = stack.pop() as SyntaxNode;
      // The outer attributes before a child: the `attribute_item`s since the last child that is
      // neither one nor a comment (comments are passed over, any other node ends the run).
      let pending: SyntaxNode[] = [];
      for (const c of n.namedChildren) {
        if (!c) continue;
        stack.push(c);
        if (isRustComment(c)) continue;
        if (c.type === 'attribute_item') {
          pending.push(c);
          continue;
        }
        if (pending.length > 0) {
          if (c.type === 'mod_item' && c.childForFieldName('body')) {
            // The nearest `#[cfg(test)]` before the module.
            for (let i = pending.length - 1; i >= 0; i--) {
              const attr = pending[i] as SyntaxNode;
              if (isCfgTest(attr)) {
                cfgTest.push({ start: attr.startPosition.row + 1, end: c.endPosition.row + 1 });
                break;
              }
            }
          }
          if (pending.some(isRustTestAttribute)) {
            const name = c.childForFieldName('name')?.text;
            if (name !== undefined) {
              addDecl(decls, { row: c.startPosition.row, col: c.startPosition.column, name, test: true, main: false });
            }
          }
          pending = [];
        }
      }
    }
    return { decls, cfgTest: cfgTest.sort((a, b) => a.start - b.start) };
  } finally {
    tree.delete();
  }
}

/** The identifiers of a Swift `user_type` (`K.Builder` is `K`, `Builder`). */
function swiftTypeIdentifiers(userType: SyntaxNode): string[] {
  return userType.namedChildren
    .filter((c): c is SyntaxNode => c !== null && c.type === 'type_identifier')
    .map((c) => c.text);
}

/** The names of the attributes among a Swift declaration's `modifiers` (`@Test(...)` is `Test`, `@main` is `main`). */
function swiftAttributeNames(decl: SyntaxNode): string[] {
  const out: string[] = [];
  for (const m of decl.namedChildren) {
    if (m?.type !== 'modifiers') continue;
    for (const a of m.namedChildren) {
      if (a?.type !== 'attribute') continue;
      const t = a.namedChild(0);
      const ids = t?.type === 'user_type' ? swiftTypeIdentifiers(t) : [];
      const last = ids[ids.length - 1];
      if (last !== undefined) out.push(last);
    }
  }
  return out;
}

/**
 * The requirement names a Swift protocol body declares: function requirements, initializers
 * (`init`), property requirements and subscripts (`subscript`). Function and initializer
 * requirements are not nodes in the index, so this is where they are read.
 */
function swiftProtocolRequirements(body: SyntaxNode): Set<string> {
  const out = new Set<string>();
  for (const c of body.namedChildren) {
    if (!c) continue;
    if (c.type === 'protocol_function_declaration') {
      const name = c.childForFieldName('name')?.text;
      if (name !== undefined) out.add(name);
    } else if (c.type === 'init_declaration') {
      out.add('init');
    } else if (c.type === 'protocol_property_declaration') {
      const name = c.childForFieldName('name')?.childForFieldName('bound_identifier')?.text;
      if (name !== undefined) out.add(name);
    } else if (c.type === 'subscript_declaration') {
      out.add('subscript');
    }
  }
  return out;
}

/** Swift ancestors that preserve a groupable type path; every other node makes its descendants local. */
const SWIFT_TYPE_PATH_ANCESTORS: ReadonlySet<string> = new Set([
  'source_file', 'class_declaration', 'protocol_declaration',
  'class_body', 'enum_class_body', 'protocol_body',
  'directive', // Compilation conditions do not introduce a scope.
]);

/**
 * One Swift parse's reading: attribute marks, and for every nonlocal type, extension and protocol
 * its type path (an extension's as written, `extension K.Builder` is `K.Builder`, prefixed with the
 * path of the type or extension it is nested in) and, for every protocol, its requirement names.
 * A declaration inside any code body, including inside a local type, has no type path.
 * The grammar must be loaded (`grammarReady`); null when the parse fails. The source goes through
 * the extractor's pre-parse transform first (see "Swift parse" in the header).
 */
function parseSwift(source: string): FileParse | null {
  const tree = parseTree('swift', joinSwiftCompositionContinuations(source));
  if (!tree) return null;
  try {
    const decls = new Map<string, Decl[]>();
    const stack: { n: SyntaxNode; container: string; local: boolean }[] = [{ n: tree.rootNode, container: '', local: false }];
    while (stack.length > 0) {
      const { n, container, local } = stack.pop() as { n: SyntaxNode; container: string; local: boolean };
      let inner = container;
      if (n.type === 'class_declaration' || n.type === 'protocol_declaration') {
        const nameNode = n.childForFieldName('name');
        if (nameNode) {
          const ids = nameNode.type === 'user_type' ? swiftTypeIdentifiers(nameNode) : [nameNode.text];
          const name = ids[ids.length - 1] ?? nameNode.text;
          const extension = n.type === 'class_declaration' && n.childForFieldName('declaration_kind')?.text === 'extension';
          const own = extension ? ids.join('.') : name;
          const typePath = local ? undefined : container === '' ? own : `${container}.${own}`;
          const attrs = swiftAttributeNames(n);
          const decl: Decl = {
            row: n.startPosition.row, col: n.startPosition.column, name,
            test: attrs.includes('Test'), main: attrs.includes('main'), typePath, extension,
          };
          if (n.type === 'protocol_declaration') {
            const body = n.childForFieldName('body');
            decl.requirements = body ? swiftProtocolRequirements(body) : new Set<string>();
          }
          addDecl(decls, decl);
          inner = typePath ?? container;
        }
      } else if (n.type === 'function_declaration' || n.type === 'init_declaration') {
        const attrs = swiftAttributeNames(n);
        if (attrs.includes('Test') || attrs.includes('main')) {
          const name = n.type === 'init_declaration' ? 'init' : n.childForFieldName('name')?.text;
          if (name !== undefined) {
            addDecl(decls, {
              row: n.startPosition.row, col: n.startPosition.column, name,
              test: attrs.includes('Test'), main: attrs.includes('main'),
            });
          }
        }
      }
      const innerLocal = local || !SWIFT_TYPE_PATH_ANCESTORS.has(n.type);
      for (const c of n.namedChildren) if (c) stack.push({ n: c, container: inner, local: innerLocal });
    }
    return { decls, cfgTest: [] };
  } finally {
    tree.delete();
  }
}

/**
 * The orphan report for `changed` over `store`: the merge base of base and HEAD
 * diffed to the working tree (`<base>...HEAD` plus uncommitted changes).
 * Git, the file system and ripgrep are reached only through `io`; the index is
 * read through `store`. The one other read is the Rust and Swift grammars the
 * attribute rules and the Swift grouping parse with: each is loaded from the
 * package when an added symbol is in a file of that language, and each file's
 * parse is cached for the run.
 */
export async function findOrphans(
  store: OrphansStore,
  changed: readonly ChangedFile[],
  io: OrphansIO,
): Promise<OrphansReport> {
  let preImageUnread = 0;

  // --- which symbols were added ---------------------------------------------
  const addedRaw: BlastNode[] = [];
  for (const file of changed) {
    if (file.status === 'deleted') continue;
    if (file.status === 'added') {
      addedRaw.push(
        ...store.symbolsOverlapping(file.path, 1, Number.MAX_SAFE_INTEGER).filter((n) => CANDIDATE_KINDS.has(n.kind)),
      );
      continue;
    }
    // `symbolsOverlapping` returns overlap; rule 2 wants the declaration line inside the range.
    const inRange = new Map<string, BlastNode>();
    if (file.ranges.length === 0) {
      // No ranges (a binary notice under `-diff`, a mode-only change, a pure rename): treat the
      // file as changed throughout, and let the pre-image name rule alone decide. `runOrphans`
      // refuses unread hunk ranges before this call; this function treats any range-less file whole.
      for (const n of store.symbolsOverlapping(file.path, 1, Number.MAX_SAFE_INTEGER)) {
        if (CANDIDATE_KINDS.has(n.kind)) inRange.set(n.id, n);
      }
    }
    for (const r of file.ranges) {
      for (const n of store.symbolsOverlapping(file.path, r.start, r.end)) {
        const { start } = spanLines(n.span);
        if (CANDIDATE_KINDS.has(n.kind) && start >= r.start && start <= r.end) inRange.set(n.id, n);
      }
    }
    if (inRange.size === 0) continue;
    const pre = io.preImage(file);
    if (pre === null) {
      preImageUnread += 1;
      addedRaw.push(...inRange.values());
      continue;
    }
    for (const n of inRange.values()) if (!containsWord(pre, n.name)) addedRaw.push(n);
  }

  const nodeCache = new Map<string, OrphanNode>();
  /** `BlastNode`s as `OrphanNode`s, with columns and language fetched in one batch and cached. */
  function withDetails(raw: readonly BlastNode[]): OrphanNode[] {
    const missing = raw.filter((n) => !nodeCache.has(n.id)).map((n) => n.id);
    const details = missing.length > 0 ? store.details(missing) : new Map<string, NodeDetail>();
    return raw.map((n) => {
      const hit = nodeCache.get(n.id);
      if (hit) return hit;
      const { start, end } = spanLines(n.span);
      const d = details.get(n.id);
      const node: OrphanNode = {
        id: n.id, name: n.name, kind: n.kind, path: n.path, startLine: start, endLine: end,
        startColumn: d?.startColumn ?? 0, endColumn: d?.endColumn ?? Number.MAX_SAFE_INTEGER,
        language: d?.language ?? '',
      };
      nodeCache.set(n.id, node);
      return node;
    });
  }
  /** Nodes by id, cached. */
  function nodes(ids: readonly string[]): OrphanNode[] {
    const missing = ids.filter((id) => !nodeCache.has(id));
    if (missing.length > 0) withDetails(store.nodesByIds(missing));
    return ids.map((id) => nodeCache.get(id)).filter((n): n is OrphanNode => n !== undefined);
  }

  const added = withDetails(addedRaw);
  const addedIds = new Set(added.map((n) => n.id));

  // --- file text and parses (the attribute rules, the Swift grouping, the protocol requirements) -------
  const textCache = new Map<string, string | null>();
  /** The file's current text, read once per path. */
  function text(path: string): string | null {
    if (!textCache.has(path)) textCache.set(path, io.source(path));
    return textCache.get(path) ?? null;
  }
  const lineCache = new Map<string, string[] | null>();
  function lines(path: string): string[] | null {
    if (!lineCache.has(path)) {
      const t = text(path);
      lineCache.set(path, t === null ? null : t.split(/\r?\n/));
    }
    return lineCache.get(path) ?? null;
  }
  // A grammar is loaded when an added symbol is in a file of that language; a type group or a
  // protocol of that language is then read through the same grammar. Not loaded (or no added
  // symbol of the language): every file of it falls back, see `fileParse`.
  const grammarOk = new Map<string, boolean>();
  for (const language of ['rust', 'swift'] as const) {
    if (added.some((s) => s.language === language)) grammarOk.set(language, await grammarReady(language));
  }
  const parseCache = new Map<string, FileParse | null>();
  /**
   * The parse of the Rust or Swift file at `path`, one per file and cached; null when the
   * language is another, its grammar did not load, the file cannot be read or the parse missed its
   * budget (the callers' fallback: the line walk for the attribute rules; for a Swift protocol or type path, no proof).
   */
  function fileParse(language: string, path: string): FileParse | null {
    if ((language !== 'rust' && language !== 'swift') || grammarOk.get(language) !== true) return null;
    if (parseCache.has(path)) return parseCache.get(path) ?? null;
    const src = text(path);
    const fp = src === null ? null : language === 'rust' ? parseRust(src) : parseSwift(src);
    parseCache.set(path, fp);
    return fp;
  }

  // --- containing types and same-named type groups ----------------------------
  const parentIds = store.parents(added.map((n) => n.id));
  /** S's containing type nodes (via `contains`). */
  const containingTypes = new Map<string, OrphanNode[]>();
  const allParentIds = [...new Set([...parentIds.values()].flat())];
  nodes(allParentIds);
  for (const s of added) {
    containingTypes.set(s.id, nodes(parentIds.get(s.id) ?? []).filter((p) => TYPE_KIND_SET.has(p.kind)));
  }

  // Only Swift shares uses across same-name type nodes (declarations and extensions), for type
  // candidates and containing types (constructor rule). A group is narrowed to nodes of one
  // proven-equal full type path (`typeKey`); other languages keep only the node itself.
  const groupKeys = new Set<string>();
  const typeNodesNeedingGroups: OrphanNode[] = [
    ...added.filter((n) => TYPE_KIND_SET.has(n.kind)),
    ...[...containingTypes.values()].flat(),
  ];
  for (const t of typeNodesNeedingGroups) if (t.language === 'swift') groupKeys.add(t.name);
  const groupByKey = new Map<string, OrphanNode[]>();
  if (groupKeys.size > 0) {
    for (const t of store.typesNamed([...groupKeys], TYPE_KINDS)) {
      nodeCache.set(t.id, nodeCache.get(t.id) ?? t);
      const key = `${t.language}\0${t.name}`;
      const at = groupByKey.get(key);
      if (at) at.push(t);
      else groupByKey.set(key, [t]);
    }
  }
  const typeKeyCache = new Map<string, string | null>();
  /**
   * A Swift type node's full type path (see "Swift grouping" in the header), read from the parse of its
   * file whatever the node's kind (a declaration's as well as an extension's; `qualified_name` is
   * never used), or null when it cannot be established (no parse, no declaration at the node's position).
   */
  function typeKey(t: OrphanNode): string | null {
    if (typeKeyCache.has(t.id)) return typeKeyCache.get(t.id) ?? null;
    const fp = fileParse('swift', t.path);
    const d = fp ? declsAt(fp, t.startLine - 1, t.startColumn, t.name).find((x) => x.typePath !== undefined) : undefined;
    const key = d?.typePath ?? null;
    typeKeyCache.set(t.id, key);
    return key;
  }
  /**
   * Only Swift groups same-named type nodes whose proven full type paths are equal.
   * An unproven path never joins another node. Every non-Swift type keeps itself
   * alone, so unrelated same-named types do not share uses.
   */
  function group(t: OrphanNode): OrphanNode[] {
    if (t.language !== 'swift') return [t];
    const all = groupByKey.get(`${t.language}\0${t.name}`) ?? [];
    const key = typeKey(t);
    const g = key === null ? [] : all.filter((x) => typeKey(x) === key);
    return g.some((x) => x.id === t.id) ? g : [t, ...g];
  }

  // --- counted uses -----------------------------------------------------------
  const useTargets = new Set<string>(addedIds);
  for (const t of typeNodesNeedingGroups) for (const g of group(t)) useTargets.add(g.id);
  const usesByTarget = new Map<string, IncomingUse[]>();
  for (const u of store.incomingUses([...useTargets])) {
    const at = usesByTarget.get(u.target);
    if (at) at.push(u);
    else usesByTarget.set(u.target, [u]);
  }
  // The `contains` ancestry of every use source (and, below, of every failed reference's from-node), fetched a
  // level at a time and cached: the own-span test's ancestry half.
  const parentCache = new Map<string, readonly string[]>();
  for (const n of added) parentCache.set(n.id, parentIds.get(n.id) ?? []);
  /** Fetch the `contains` parents of `ids` and of every ancestor above them, once each. */
  function loadAncestors(ids: Iterable<string>): void {
    let frontier = [...new Set(ids)].filter((id) => !parentCache.has(id));
    while (frontier.length > 0) {
      const got = store.parents(frontier);
      const next = new Set<string>();
      for (const id of frontier) {
        const ps = got.get(id) ?? [];
        parentCache.set(id, ps);
        for (const p of ps) if (!parentCache.has(p)) next.add(p);
      }
      frontier = [...next];
    }
  }
  /** Whether `ancestor` holds `id` over `contains` edges, at any depth (ids loaded by `loadAncestors`; a cycle ends at its first repeat). */
  function hasAncestor(ancestor: string, id: string): boolean {
    const seen = new Set<string>([id]);
    const stack = [id];
    while (stack.length > 0) {
      for (const p of parentCache.get(stack.pop() as string) ?? []) {
        if (p === ancestor) return true;
        if (!seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    return false;
  }
  /**
   * The own-span test: whether the node `id` (in `path`, with `span`) is inside S: it is S, or S is its
   * `contains` ancestor, or it is in S's file and its (line, column) span lies inside S's.
   */
  function insideOf(
    s: OrphanNode,
    id: string,
    path: string,
    span: { startLine: number; startColumn: number; endLine: number; endColumn: number },
  ): boolean {
    return id === s.id || (path === s.path && spanInside(span, s)) || hasAncestor(s.id, id);
  }
  loadAncestors([...usesByTarget.values()].flatMap((us) => us.map((u) => u.source)));
  /** Incoming uses of one node, minus those from inside it (the own-span test). */
  function ownCounted(n: OrphanNode): IncomingUse[] {
    return (usesByTarget.get(n.id) ?? []).filter(
      (u) =>
        !insideOf(n, u.source, u.sourcePath, {
          startLine: u.sourceStart, startColumn: u.sourceStartColumn, endLine: u.sourceEnd, endColumn: u.sourceEndColumn,
        }),
    );
  }
  /** Counted uses of S: its own, or only for a Swift type, those of its proven same-name group. */
  function counted(n: OrphanNode): IncomingUse[] {
    if (!TYPE_KIND_SET.has(n.kind)) return ownCounted(n);
    return group(n).flatMap(ownCounted);
  }

  // --- implementation check (indexed conformances, external table) ------------
  const conformanceCache = new Map<string, string[]>();
  const memberCache = new Map<string, Set<string>>();
  function conformancesOf(ids: readonly string[]): void {
    const missing = ids.filter((id) => !conformanceCache.has(id));
    if (missing.length === 0) return;
    const got = store.conformances(missing);
    for (const id of missing) conformanceCache.set(id, got.get(id) ?? []);
  }
  function membersOf(ids: readonly string[]): void {
    const missing = ids.filter((id) => !memberCache.has(id));
    if (missing.length === 0) return;
    const got = store.memberNames(missing);
    for (const id of missing) memberCache.set(id, got.get(id) ?? new Set());
  }
  /** A Swift protocol (an `interface` node of language swift): its function requirements are not nodes. */
  const isSwiftProtocol = (t: OrphanNode): boolean =>
    t.language === 'swift' && (t.kind === 'interface' || t.kind === 'protocol');
  /** The requirement names a Swift protocol's body declares in the Swift parse, or null when that parse (or the declaration in it) is unavailable. */
  function protocolRequirements(t: OrphanNode): Set<string> | null {
    const fp = fileParse('swift', t.path);
    if (!fp) return null;
    return declsAt(fp, t.startLine - 1, t.startColumn, t.name).find((d) => d.requirements !== undefined)?.requirements ?? null;
  }
  /** S's containing types for the indexed-conformance check and the external-conformance table: via `contains`, plus for Swift every same-named type node of the same type path. */
  function conformingTypes(s: OrphanNode): OrphanNode[] {
    const out = new Map<string, OrphanNode>();
    for (const t of containingTypes.get(s.id) ?? []) {
      out.set(t.id, t);
      if (t.language === 'swift') for (const g of group(t)) out.set(g.id, g);
    }
    return [...out.values()];
  }
  /**
   * The indexed-conformance check: an indexed type reached over implements/extends has an indexed member
   * named S's name; a Swift protocol, whose function requirements are not nodes, declares it in its parsed body.
   */
  function implementsIndexed(s: OrphanNode, starts: readonly OrphanNode[]): boolean {
    const seen = new Set(starts.map((t) => t.id));
    let frontier = starts.map((t) => t.id);
    for (let depth = 0; depth < CONFORMANCE_DEPTH && frontier.length > 0; depth++) {
      conformancesOf(frontier);
      const next = [...new Set(frontier.flatMap((id) => conformanceCache.get(id) ?? []))].filter((id) => !seen.has(id));
      if (next.length === 0) return false;
      for (const id of next) seen.add(id);
      membersOf(next);
      for (const t of nodes(next)) {
        if (memberCache.get(t.id)?.has(s.name)) return true;
        if (isSwiftProtocol(t)) {
          const requirements = protocolRequirements(t);
          // An unavailable requirement set (null) proves nothing: no text of the span stands in for it.
          if (requirements?.has(s.name)) return true;
        }
      }
      frontier = next;
    }
    return false;
  }

  // --- classify -----------------------------------------------------------------
  const report: OrphansReport = {
    added: added.length,
    orphans: [],
    guessed: [],
    excluded: { test: 0, implementation: 0, constructor: 0, entry: 0 },
    preImageUnread,
    searchUnread: 0,
  };
  /** A candidate with no counted use, checked by the unresolved-reference and text-mention checks after the loop. */
  interface Suspect { s: OrphanNode; entry: OrphanEntry }
  const suspects: Suspect[] = [];
  const memberCandidates = added.filter((s) => MEMBER_KINDS.has(s.kind));
  const externalByType = store.externalConformances([
    ...new Set(memberCandidates.flatMap((s) => conformingTypes(s).map((t) => t.id))),
  ]);

  /**
   * The line-walk fallback of the test and entry-point rules: whether `n`'s start line, or the
   * attribute / comment lines just above it, match `attr`. A comment line (`COMMENT_LINE`) is
   * walked over, never matched. Null `attr` (no attribute in this language) is false without
   * reading the file.
   */
  function hasAttribute(n: { path: string; startLine: number }, attr: RegExp | null): boolean {
    if (attr === null) return false;
    const ls = lines(n.path);
    if (!ls) return false;
    const marks = (l: string): boolean => !COMMENT_LINE.test(l) && attr.test(l);
    const at = n.startLine - 1;
    if (marks(ls[at] ?? '')) return true;
    for (let i = at - 1; i >= 0 && i >= at - ATTRIBUTE_LOOKBACK; i--) {
      const l = ls[i] ?? '';
      if (!ATTRIBUTE_OR_COMMENT.test(l)) break;
      if (marks(l)) return true;
    }
    return false;
  }
  /**
   * Whether the declaration of `n` (a symbol of `language`) carries the test or entry attribute:
   * read from the file's parse by the declaration's start position (row, and column when known)
   * and name; the line walk (`hasAttribute`) only when the file has no parse.
   */
  function hasMark(
    n: { name: string; path: string; startLine: number; startColumn?: number },
    language: string,
    mark: 'test' | 'main',
  ): boolean {
    const fp = fileParse(language, n.path);
    if (fp) return declsAt(fp, n.startLine - 1, n.startColumn ?? null, n.name).some((d) => d[mark]);
    return hasAttribute(n, mark === 'test' ? testAttributeFor(language) : language === 'swift' ? MAIN_ATTRIBUTE : null);
  }
  /**
   * The test rule by name or attribute (`language` picks the attribute): also
   * the test a symbol enclosing S is held to in the nested-in-test rule.
   */
  function isTestByMark(n: { name: string; path: string; startLine: number; startColumn?: number }, language: string): boolean {
    return TEST_NAME.test(n.name) || hasMark(n, language, 'test');
  }
  /** The nested-in-test rule's Rust `#[cfg(test)]` module ranges of a file (from its one parse; none when it has none). */
  const cfgRanges = (path: string): { start: number; end: number }[] => fileParse('rust', path)?.cfgTest ?? [];
  function isTest(s: OrphanNode): boolean {
    if (TEST_PATH.test(s.path) || isTestByMark(s, s.language)) return true;
    // Nested-in-test rule: inside a test-marked symbol of the same file (one overlap query per
    // candidate), whose attributes are read as S's language: one file, one language.
    for (const n of store.symbolsOverlapping(s.path, s.startLine, s.endLine)) {
      if (n.id === s.id) continue;
      const { start, end } = spanLines(n.span);
      const encloses = start <= s.startLine && end >= s.endLine && (start < s.startLine || end > s.endLine);
      if (encloses && isTestByMark({ name: n.name, path: n.path, startLine: start }, s.language)) return true;
    }
    if (s.language === 'rust') {
      return cfgRanges(s.path).some((r) => r.start <= s.startLine && r.end >= s.endLine);
    }
    return false;
  }

  /** Entry-point rule: a Swift type declared under `@main`, cached by id. */
  const mainTypeCache = new Map<string, boolean>();
  function isMainType(t: OrphanNode): boolean {
    let v = mainTypeCache.get(t.id);
    if (v === undefined) {
      v = hasMark(t, t.language, 'main');
      mainTypeCache.set(t.id, v);
    }
    return v;
  }
  /** A top-level entry is not held by a function or method. */
  const isTopLevel = (s: OrphanNode): boolean =>
    !nodes(parentIds.get(s.id) ?? []).some((p) => CALLABLE_KINDS.has(p.kind));
  /** A module hook is not held by a function, method or type. */
  const isModuleLevel = (s: OrphanNode): boolean =>
    !nodes(parentIds.get(s.id) ?? []).some((p) => CALLABLE_KINDS.has(p.kind) || TYPE_KIND_SET.has(p.kind));
  function isEntry(s: OrphanNode): boolean {
    if (TYPE_KIND_SET.has(s.kind)) return isMainType(s);
    if (s.language === 'go' && s.kind === 'function' && s.name === GO_INIT_NAME) return isTopLevel(s);
    if (s.language === 'python' && PYTHON_DUNDER.test(s.name)) {
      if (s.kind === 'method') return true;
      if (s.kind === 'function') return PYTHON_MODULE_HOOKS.has(s.name) && isModuleLevel(s);
    }
    if (s.name !== ENTRY_NAME) return false;
    if (s.kind === 'function' && isTopLevel(s)) return true;
    return MEMBER_KINDS.has(s.kind) && conformingTypes(s).some(isMainType);
  }

  for (const s of added) {
    if (isTest(s)) {
      report.excluded.test += 1;
      continue;
    }
    if (isEntry(s)) {
      report.excluded.entry += 1;
      continue;
    }
    let external: string[] | undefined;
    if (MEMBER_KINDS.has(s.kind)) {
      const types = conformingTypes(s);
      // Requirement rule: a requirement of a used interface / trait / protocol.
      if (containingTypes.get(s.id)?.some((t) => REQUIREMENT_CONTAINER_KINDS.has(t.kind) && counted(t).length > 0)) {
        report.excluded.implementation += 1;
        continue;
      }
      if (types.length > 0 && implementsIndexed(s, types)) {
        report.excluded.implementation += 1;
        continue;
      }
      const refs = [...new Set(types.flatMap((t) => externalByType.get(t.id) ?? []).map(lastSegment))].sort(cmp);
      if (refs.length > 0) {
        if (refs.some((r) => externalRequirements(s.language, r)?.includes(s.name))) {
          report.excluded.implementation += 1;
          continue;
        }
        external = refs;
      }
    }
    if (CONSTRUCTOR_NAMES.has(s.name) && (containingTypes.get(s.id) ?? []).some((t) => counted(t).length > 0)) {
      report.excluded.constructor += 1;
      continue;
    }
    const uses = counted(s);
    const entry: OrphanEntry = {
      id: s.id, name: s.name, kind: s.kind, path: s.path, span: `L${s.startLine}-L${s.endLine}`,
      ...(external ? { externalConformances: external } : {}),
    };
    if (uses.length === 0) {
      suspects.push({ s, entry });
    } else if (uses.every((u) => isGuess(u.kind, u.metadata, u.sourcePath, u.targetPath))) {
      // Each edge's own target file, not S's: a type's uses come from its whole same-name group.
      const edges = uses
        .map((u): GuessEdge => ({
          source: u.source,
          sourceName: u.sourceName,
          sourcePath: u.sourcePath,
          line: u.line,
          kind: u.kind,
          resolvedBy: typeof u.metadata.resolvedBy === 'string' ? u.metadata.resolvedBy : null,
          confidence: typeof u.metadata.confidence === 'number' ? u.metadata.confidence : null,
        }))
        .sort((a, b) => cmp(a.sourcePath, b.sourcePath) || a.line - b.line || cmp(a.source, b.source));
      report.guessed.push(guessedEntry(entry, edges, [], []));
    }
  }

  // --- unresolved-reference check: failed references naming a suspect ---------
  let left: Suspect[] = suspects;
  if (left.length > 0) {
    const refsByName = new Map<string, FailedRef[]>();
    const failed = store.failedRefsNamed([...new Set(left.map((x) => x.s.name))]);
    loadAncestors(failed.map((r) => r.fromNode));
    for (const r of failed) {
      const at = refsByName.get(r.nameTail);
      if (at) at.push(r);
      else refsByName.set(r.nameTail, [r]);
    }
    const next: Suspect[] = [];
    for (const x of left) {
      const lang = languageKey(x.s.language);
      const containerNames = (containingTypes.get(x.s.id) ?? []).map((t) => t.name);
      const rank = (u: UnresolvedEvidence): number => refRank(u.name, u.path, x.s, containerNames);
      const refs = (refsByName.get(x.s.name) ?? [])
        .filter((r) => languageKey(r.language) === lang)
        // The from-node's own-span test is the incoming uses' (ancestry, then line and column).
        .filter((r) => !insideOf(x.s, r.fromNode, r.fromPath, {
          startLine: r.fromStart, startColumn: r.fromStartColumn, endLine: r.fromEnd, endColumn: r.fromEndColumn,
        }))
        .map((r): UnresolvedEvidence => ({ name: r.referenceName, kind: r.referenceKind, path: r.path, line: r.line }))
        .sort((a, b) => rank(a) - rank(b) || cmp(a.path, b.path) || a.line - b.line || cmp(a.name, b.name));
      if (refs.length > 0) {
        report.guessed.push(guessedEntry(x.entry, [], refs.slice(0, EVIDENCE_KEPT), [], { unresolved: refs.length }));
      } else {
        next.push(x);
      }
    }
    left = next;
  }

  // --- text-mention check: mentions of a suspect outside its own span ---------
  const searchable = left.filter((x) => IDENTIFIER_NAME.test(x.s.name));
  /** The searchable suspects by name. */
  const byName = new Map<string, Suspect[]>();
  for (const x of searchable) {
    const at = byName.get(x.s.name);
    if (at) at.push(x);
    else byName.set(x.s.name, [x]);
  }
  // The hits of a name, held once per name whatever number of suspects share it: the distinct
  // lines per file, and how many in all. A suspect's mentions are these minus the lines of its own
  // span (by line alone: the search reports lines).
  const hitLines = new Map<string, Map<string, Set<number>>>();
  const hitTotal = new Map<string, number>();
  /** A hit naming `name`. */
  function mention(name: string, h: TextHit): void {
    const byPath = hitLines.get(name) ?? new Map<string, Set<number>>();
    hitLines.set(name, byPath);
    const lineSet = byPath.get(h.path) ?? new Set<number>();
    byPath.set(h.path, lineSet);
    if (lineSet.has(h.line)) return;
    lineSet.add(h.line);
    hitTotal.set(name, (hitTotal.get(name) ?? 0) + 1);
  }
  /** How many distinct hit lines of S's name lie inside S's own span (in S's own file, by line). */
  function ownHits(x: Suspect): number {
    const lineSet = hitLines.get(x.s.name)?.get(x.s.path);
    if (!lineSet) return 0;
    let inside = 0;
    if (lineSet.size <= x.s.endLine - x.s.startLine + 1) {
      for (const l of lineSet) if (l >= x.s.startLine && l <= x.s.endLine) inside += 1;
    } else {
      for (let l = x.s.startLine; l <= x.s.endLine; l++) if (lineSet.has(l)) inside += 1;
    }
    return inside;
  }
  /** The distinct hit lines of S's name outside S's own span: its `mentionCount`; above 0, S has a mention. */
  const outsideCount = (x: Suspect): number => (hitTotal.get(x.s.name) ?? 0) - ownHits(x);
  /** Whether some suspect named `name` still has no mention. */
  const lacking = (name: string): boolean => (byName.get(name) ?? []).some((x) => outsideCount(x) === 0);
  /**
   * One search for `names`, keeping at most `maxHits` hits; true when it dropped
   * some. With one name every hit is that name's (ripgrep matched it); with
   * several, the file's own line (not the search's possibly cut copy) says which.
   * Its unread-file count raises `report.searchUnread` to it (the most, not the sum:
   * each run searches every indexed file).
   */
  async function searchOnce(names: readonly string[], maxHits: number): Promise<boolean> {
    const pattern = mentionPattern(names);
    const patternBudget = mentionPatternBytes();
    if (Buffer.byteLength(pattern) > patternBudget) {
      throw new MentionSearchIncompleteError(
        `a name is too long to search for (${Buffer.byteLength(pattern)} bytes of pattern, over ${patternBudget}): ` +
        `"${(names[0] ?? '').slice(0, 40)}…" cannot be checked for text mentions, so orphans will not call it orphaned`,
      );
    }
    const { hits, truncated, unread } = await io.search(pattern, maxHits);
    report.searchUnread = Math.max(report.searchUnread, unread);
    const only = names.length === 1 ? names[0] : undefined;
    if (only !== undefined) {
      for (const h of hits) mention(only, h);
    } else {
      const named = new RegExp(`(?<!${IDENT})(?:${names.map(escapeName).join('|')})(?!${IDENT})`, 'gu');
      for (const h of hits) {
        const lineText = lines(h.path)?.[h.line - 1] ?? h.text;
        for (const m of new Set([...lineText.matchAll(named)].map((x) => x[0]))) mention(m, h);
      }
    }
    return truncated;
  }
  /**
   * At most how many of a name-alone search's hits can lie inside `x`'s own span:
   * the span's lines that contain the name at all (a superset of ripgrep's word
   * matches, one hit per line), or every line of the span when the file cannot be read.
   */
  function ownHitBound(x: Suspect): number {
    const ls = lines(x.s.path);
    if (!ls) return x.s.endLine - x.s.startLine + 1;
    return ls.slice(Math.max(0, x.s.startLine - 1), x.s.endLine).filter((l) => l.includes(x.s.name)).length;
  }
  // Batched runs. A batch whose run dropped hits is searched again for its names still
  // without a mention while that settles some; a batch that settles none is stuck.
  let pending = [...byName.keys()];
  const stuck: string[] = [];
  while (pending.length > 0) {
    const again: string[] = [];
    for (const batch of mentionBatches(pending)) {
      if (!(await searchOnce(batch, MENTION_SEARCH_CAP))) continue;
      const still = batch.filter(lacking);
      (still.length < batch.length ? again : stuck).push(...still);
    }
    pending = again;
  }
  // Name-alone runs for the stuck names. Keeping the cap plus the most hits any one
  // unmentioned suspect's own span can hold, a run that still drops hits has kept a line
  // outside each such span, so a suspect left without a mention means the files changed
  // under the search.
  for (const name of stuck) {
    const own = Math.max(0, ...(byName.get(name) ?? []).filter((x) => outsideCount(x) === 0).map(ownHitBound));
    if ((await searchOnce([name], MENTION_SEARCH_CAP + own)) && lacking(name)) {
      throw new MentionSearchIncompleteError(
        `the text-mention search for "${name}" dropped hits past its cap and kept none outside the symbol's own span ` +
        '(a file changed during the run?); orphans will not call it orphaned without that check — run it again',
      );
    }
  }
  /** A name's distinct hit lines, by path then line, built once. */
  const sortedHitCache = new Map<string, MentionEvidence[]>();
  function sortedHits(name: string): MentionEvidence[] {
    let out = sortedHitCache.get(name);
    if (!out) {
      out = [];
      const byPath = hitLines.get(name) ?? new Map<string, Set<number>>();
      for (const path of [...byPath.keys()].sort(cmp)) {
        for (const line of [...(byPath.get(path) ?? [])].sort((a, b) => a - b)) out.push({ path, line });
      }
      sortedHitCache.set(name, out);
    }
    return out;
  }
  /** S's first `EVIDENCE_KEPT` mention lines outside its own span, by path then line. */
  function keptMentions(x: Suspect): MentionEvidence[] {
    const kept: MentionEvidence[] = [];
    for (const h of sortedHits(x.s.name)) {
      if (h.path === x.s.path && h.line >= x.s.startLine && h.line <= x.s.endLine) continue;
      kept.push(h);
      if (kept.length === EVIDENCE_KEPT) break;
    }
    return kept;
  }
  for (const x of left) {
    const outside = outsideCount(x);
    if (outside > 0) {
      report.guessed.push(guessedEntry(x.entry, [], [], keptMentions(x), { mentions: outside }));
    } else {
      report.orphans.push(x.entry);
    }
  }

  const start = (e: OrphanEntry): number => spanLines(e.span).start;
  const byPosition = (a: OrphanEntry, b: OrphanEntry): number => cmp(a.path, b.path) || start(a) - start(b) || cmp(a.id, b.id);
  report.orphans.sort(byPosition);
  report.guessed.sort(byPosition);
  return report;
}
