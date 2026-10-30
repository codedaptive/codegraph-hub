/**
 * Suspect call edges: the `calls` edges the resolver bound by NAME ONLY, ranked by how
 * likely each one is wrong. Read-only over an existing index; nothing here writes.
 * Reached through ./extension.ts: the CLI `codegraph suspects` and the MCP tool `codegraph_suspects`.
 *
 * CANDIDATE EDGE. kind = 'calls', `metadata.resolvedBy` present, and name-only:
 *   resolvedBy IN ('exact-match', 'fuzzy')  OR  (resolvedBy = 'instance-method' AND confidence < 0.9).
 * Why: this is the complement of the DECLARED predicate in `aggregateModuleGraph`
 * (src/db/queries.ts: import, qualified-name, or instance-method at >= 0.9, i.e. a receiver
 * whose type was declared), minus 'framework', 'file-path' and 'function-ref' — framework
 * edges are pattern matches, not name guesses; file-path and function-ref edges bind by path
 * or by a function value, not by name. An instance-method edge below 0.9
 * is one the resolver bound with less than a declared receiver type: an inferred or
 * inherited type, a single trait or impl in scope, or a single owner of the name (0.85 or
 * 0.8), or a weaker guess (0.7 or 0.65). Every such edge is a candidate. Synthesized edges carry no
 * resolvedBy and are excluded. A missing confidence counts as 1.
 *
 * FLAGS (on each edge; a target's flags are the union, in SuspectFlag order):
 *   std-collision        the target's name is a standard-library method name in its language
 *                        (`options.isStdMethod`, default `stdCollision`): a call like
 *                        `items.sorted()` on a stdlib value was bound to a project method.
 *                        The default `stdCollision` knows Rust only; Swift waits on its
 *                        marked call site.
 *   missing-import       the caller and target sit in different known modules and the caller's
 *                        file does not import the target's module (see below).
 *   several-definitions  more than one function/method node of the target's name and language
 *                        exists, so a name match had more than one place to land.
 *   low-confidence       the edge's confidence is below 0.8.
 *
 * SCORE. An edge scores std-collision 4 + missing-import 3 + several-definitions 2 +
 * low-confidence 1; 0 means name-only and nothing else (still listed). A target's score is
 * the max over its edges. Targets rank by score desc, then edgeCount desc, then
 * targetQualifiedName asc, then targetId asc; a target's edges rank by score desc, then
 * callerFile asc, then line asc (no line last), then callerId asc. Every comparison is a
 * plain code-unit comparison, so the order is deterministic across locales.
 *
 * MISSING-IMPORT abstains (does not flag) whenever a module is unknown, and when caller and
 * target are in different languages.
 *   Swift module: the path segment after the last `Sources` or `Tests` directory, when a
 *     further directory follows it (SwiftPM layout); otherwise unknown, so Xcode-style
 *     layouts abstain. That directory decides sameness; the name an import must use is the
 *     directory's c99name (`swiftModuleName`, SwiftPM's own rule: each Unicode scalar outside
 *     its C99 Annex D allowed-range table becomes `_`, and a leading digit is replaced by
 *     `_`; `Sources/mcp-benchmarker` is imported as `mcp_benchmarker`). An `import` node in
 *     the caller's file whose name before its first '.' equals that name counts (`import X`,
 *     `@testable import X`, `import struct X.Y`).
 *     Known limitation: Package.swift is not read, so a target whose `path:` gives it a
 *     name different from its directory is still named by the directory.
 *   Rust crate: from the Cargo workspace. The root `Cargo.toml`'s `[workspace] members`
 *     (globs expanded) and each member's `[package] name` are read by upstream's
 *     `getCargoWorkspaceCrateMap`, not parsed here. A file's crate is the member directory that
 *     is the longest `member + '/'` prefix of its path (a member `.` is the root and matches
 *     every file, at the lowest priority); its name is the package name with '-' -> '_'. Two
 *     files are in the same crate when their member directories are equal. A project with no
 *     root workspace, or a file under no member, has an unknown crate, so it abstains. An
 *     `import` node in the caller's file named the crate (the first segment of
 *     `use crate_name::…`), or a refName starting with `<crate>::`, counts. `use crate::…` /
 *     `self::` / `super::` never name another crate.
 *     Known limitation: glob imports (`use b::*`), renames (`use b::X as Y`, `use b as c`),
 *     `extern crate` and `mod` produce no import node, so a caller that reaches another
 *     crate only through them is flagged.
 *   Other languages: unknown (abstain).
 *
 * The Swift standard-library list (SWIFT_STD_METHODS) is private to name-matcher.ts's Swift
 * filter and not exported yet; see the one marked call site in `stdCollision`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseConnection, getDatabasePath } from '../../db';
import type { SqliteDatabase } from '../../db/sqlite-adapter';
import { getCargoWorkspaceCrateMap } from '../../resolution/frameworks/cargo-workspace';
import { isStdMethodName } from '../../resolution/name-matcher';
import type { ResolutionContext } from '../../resolution/types';

export type SuspectFlag = 'std-collision' | 'missing-import' | 'several-definitions' | 'low-confidence';

/** The fixed flag order, used for every flag list this module emits. */
const FLAG_ORDER: readonly SuspectFlag[] = ['std-collision', 'missing-import', 'several-definitions', 'low-confidence'];

/**
 * Per-flag edge score weights: how strongly each flag suggests a wrong binding, std-collision
 * highest. Scores add, so missing-import + several-definitions (5) outrank std-collision
 * alone (4).
 */
const FLAG_WEIGHT: Readonly<Record<SuspectFlag, number>> = {
  'std-collision': 4,
  'missing-import': 3,
  'several-definitions': 2,
  'low-confidence': 1,
};

/** Below this an instance-method edge was bound without a declared receiver type; at or above it the type was declared. */
const DECLARED_INSTANCE_CONFIDENCE = 0.9;
/** Below this a candidate edge is flagged low-confidence. */
const LOW_CONFIDENCE = 0.8;
const DEFAULT_MAX_EDGES_PER_TARGET = 5;

export interface SuspectEdge {
  callerId: string;
  callerName: string;
  callerFile: string;
  line: number | null;
  refName: string | null;
  resolvedBy: string;
  confidence: number;
  flags: SuspectFlag[];
}

export interface Suspect {
  targetId: string;
  targetName: string;
  targetQualifiedName: string;
  targetKind: string;
  targetFile: string;
  targetLine: number;
  language: string;
  /** Union over its edges, in SuspectFlag order. */
  flags: SuspectFlag[];
  /** Function/method nodes of the target's name in the same language. */
  definitions: number;
  /** The max edge score. */
  score: number;
  /** All suspect call edges to this target (before maxEdgesPerTarget). */
  edgeCount: number;
  /** Score desc, then callerFile, then line (none last), then callerId; at most maxEdgesPerTarget. */
  edges: SuspectEdge[];
}

export interface SuspectOptions {
  /** Maximum number of targets returned; default no limit. */
  limit?: number;
  /** Maximum edges listed per target; default 5. edgeCount still counts all of them. */
  maxEdgesPerTarget?: number;
  /** Standard-library method-name predicate; default `stdCollision`. */
  isStdMethod?: (language: string, name: string) => boolean;
}

/** Whether `name` is a standard-library method name in `language` (Rust today; Swift once the marked call site is switched). */
export function stdCollision(language: string, name: string): boolean {
  switch (language) {
    case 'rust':
      return isStdMethodName('rust', name);
    case 'swift':
      // SWIFT-STD CALL SITE: switch this to the swift-builtins export when it lands.
      // isStdMethodName returns false for Swift today: its stdMethodNames switch has no
      // 'swift' case, and SWIFT_STD_METHODS is private to name-matcher.ts's Swift filter.
      // Do not copy the list here.
      return isStdMethodName('swift', name);
    default:
      return false;
  }
}

interface CandidateRow {
  callerId: string;
  callerName: string;
  callerFile: string;
  callerLanguage: string;
  line: number | null;
  refName: string | null;
  resolvedBy: string;
  confidence: number;
  targetId: string;
  targetName: string;
  targetQualifiedName: string;
  targetKind: string;
  targetFile: string;
  targetLine: number;
  targetLanguage: string;
}

/** The candidate predicate from the header, as SQL over `edges e`. */
const CANDIDATE_SQL = `
  SELECT s.id AS callerId, s.name AS callerName, s.file_path AS callerFile, s.language AS callerLanguage,
         e.line AS line,
         json_extract(e.metadata, '$.refName') AS refName,
         json_extract(e.metadata, '$.resolvedBy') AS resolvedBy,
         COALESCE(json_extract(e.metadata, '$.confidence'), 1) AS confidence,
         t.id AS targetId, t.name AS targetName, t.qualified_name AS targetQualifiedName,
         t.kind AS targetKind, t.file_path AS targetFile, t.start_line AS targetLine,
         t.language AS targetLanguage
    FROM edges e
    JOIN nodes s ON s.id = e.source
    JOIN nodes t ON t.id = e.target
   WHERE e.kind = 'calls'
     AND json_extract(e.metadata, '$.resolvedBy') IS NOT NULL
     AND (json_extract(e.metadata, '$.resolvedBy') IN ('exact-match', 'fuzzy')
          OR (json_extract(e.metadata, '$.resolvedBy') = 'instance-method'
              AND COALESCE(json_extract(e.metadata, '$.confidence'), 1) < ${DECLARED_INSTANCE_CONFIDENCE}))`;

/** A file's module: `id` decides sameness, `name` is what an import must name. */
interface ModuleOf {
  id: string;
  name: string;
}

function dirSegments(filePath: string): string[] {
  const segments = filePath.split(/[\\/]/).filter((s) => s.length > 0);
  segments.pop(); // the file name
  return segments;
}

/**
 * The Unicode scalars SwiftPM keeps in a c99name, as inclusive [first, last] code-point
 * ranges: ASCII letters, digits and `_`, then C99 Annex D's extended-identifier ranges.
 * Copied range for range, in source order, from `spm_mangledToC99ExtendedIdentifier` in
 * swift-tools-support-core Sources/TSCUtility/StringMangling.swift at commit
 * c574915fe88e942e4c4c93376f022daa2ecf05f9. The table is not a Unicode property: it allows
 * U+2160-U+2182 (Roman numerals) and precomposed U+00EF, but not U+00BD (½) or the
 * combining diaeresis U+0308. Edit it only by re-copying that source.
 */
const C99_ALLOWED_RANGES: readonly (readonly [number, number])[] = [
  // A-Z, a-z, 0-9, _
  [0x0041, 0x005a], [0x0061, 0x007a], [0x0030, 0x0039], [0x005f, 0x005f],
  // Latin (1)
  [0x00aa, 0x00aa],
  // Special characters (1)
  [0x00b5, 0x00b5], [0x00b7, 0x00b7],
  // Latin (2)
  [0x00ba, 0x00ba], [0x00c0, 0x00d6], [0x00d8, 0x00f6],
  [0x00f8, 0x01f5], [0x01fa, 0x0217], [0x0250, 0x02a8],
  // Special characters (2)
  [0x02b0, 0x02b8], [0x02bb, 0x02bb], [0x02bd, 0x02c1],
  [0x02d0, 0x02d1], [0x02e0, 0x02e4], [0x037a, 0x037a],
  // Greek (1)
  [0x0386, 0x0386], [0x0388, 0x038a], [0x038c, 0x038c],
  [0x038e, 0x03a1], [0x03a3, 0x03ce], [0x03d0, 0x03d6],
  [0x03da, 0x03da], [0x03dc, 0x03dc], [0x03de, 0x03de],
  [0x03e0, 0x03e0], [0x03e2, 0x03f3],
  // Cyrillic
  [0x0401, 0x040c], [0x040e, 0x044f], [0x0451, 0x045c],
  [0x045e, 0x0481], [0x0490, 0x04c4], [0x04c7, 0x04c8],
  [0x04cb, 0x04cc], [0x04d0, 0x04eb], [0x04ee, 0x04f5],
  [0x04f8, 0x04f9],
  // Armenian (1)
  [0x0531, 0x0556],
  // Special characters (3)
  [0x0559, 0x0559],
  // Armenian (2)
  [0x0561, 0x0587],
  // Hebrew
  [0x05b0, 0x05b9], [0x05bb, 0x05bd], [0x05bf, 0x05bf],
  [0x05c1, 0x05c2], [0x05d0, 0x05ea], [0x05f0, 0x05f2],
  // Arabic (1)
  [0x0621, 0x063a], [0x0640, 0x0652],
  // Digits (1)
  [0x0660, 0x0669],
  // Arabic (2)
  [0x0670, 0x06b7], [0x06ba, 0x06be], [0x06c0, 0x06ce],
  [0x06d0, 0x06dc], [0x06e5, 0x06e8], [0x06ea, 0x06ed],
  // Digits (2)
  [0x06f0, 0x06f9],
  // Devanagari and special character 0x093D
  [0x0901, 0x0903], [0x0905, 0x0939], [0x093d, 0x094d],
  [0x0950, 0x0952], [0x0958, 0x0963],
  // Digits (3)
  [0x0966, 0x096f],
  // Bengali (1)
  [0x0981, 0x0983], [0x0985, 0x098c], [0x098f, 0x0990],
  [0x0993, 0x09a8], [0x09aa, 0x09b0], [0x09b2, 0x09b2],
  [0x09b6, 0x09b9], [0x09be, 0x09c4], [0x09c7, 0x09c8],
  [0x09cb, 0x09cd], [0x09dc, 0x09dd], [0x09df, 0x09e3],
  // Digits (4)
  [0x09e6, 0x09ef],
  // Bengali (2)
  [0x09f0, 0x09f1],
  // Gurmukhi (1)
  [0x0a02, 0x0a02], [0x0a05, 0x0a0a], [0x0a0f, 0x0a10],
  [0x0a13, 0x0a28], [0x0a2a, 0x0a30], [0x0a32, 0x0a33],
  [0x0a35, 0x0a36], [0x0a38, 0x0a39], [0x0a3e, 0x0a42],
  [0x0a47, 0x0a48], [0x0a4b, 0x0a4d], [0x0a59, 0x0a5c],
  [0x0a5e, 0x0a5e],
  // Digits (5)
  [0x0a66, 0x0a6f],
  // Gurmukhi (2)
  [0x0a74, 0x0a74],
  // Gujarati
  [0x0a81, 0x0a83], [0x0a85, 0x0a8b], [0x0a8d, 0x0a8d],
  [0x0a8f, 0x0a91], [0x0a93, 0x0aa8], [0x0aaa, 0x0ab0],
  [0x0ab2, 0x0ab3], [0x0ab5, 0x0ab9], [0x0abd, 0x0ac5],
  [0x0ac7, 0x0ac9], [0x0acb, 0x0acd], [0x0ad0, 0x0ad0],
  [0x0ae0, 0x0ae0],
  // Digits (6)
  [0x0ae6, 0x0aef],
  // Oriya and special character 0x0B3D
  [0x0b01, 0x0b03], [0x0b05, 0x0b0c], [0x0b0f, 0x0b10],
  [0x0b13, 0x0b28], [0x0b2a, 0x0b30], [0x0b32, 0x0b33],
  [0x0b36, 0x0b39], [0x0b3d, 0x0b43], [0x0b47, 0x0b48],
  [0x0b4b, 0x0b4d], [0x0b5c, 0x0b5d], [0x0b5f, 0x0b61],
  // Digits (7)
  [0x0b66, 0x0b6f],
  // Tamil
  [0x0b82, 0x0b83], [0x0b85, 0x0b8a], [0x0b8e, 0x0b90],
  [0x0b92, 0x0b95], [0x0b99, 0x0b9a], [0x0b9c, 0x0b9c],
  [0x0b9e, 0x0b9f], [0x0ba3, 0x0ba4], [0x0ba8, 0x0baa],
  [0x0bae, 0x0bb5], [0x0bb7, 0x0bb9], [0x0bbe, 0x0bc2],
  [0x0bc6, 0x0bc8], [0x0bca, 0x0bcd],
  // Digits (8)
  [0x0be7, 0x0bef],
  // Telugu
  [0x0c01, 0x0c03], [0x0c05, 0x0c0c], [0x0c0e, 0x0c10],
  [0x0c12, 0x0c28], [0x0c2a, 0x0c33], [0x0c35, 0x0c39],
  [0x0c3e, 0x0c44], [0x0c46, 0x0c48], [0x0c4a, 0x0c4d],
  [0x0c60, 0x0c61],
  // Digits (9)
  [0x0c66, 0x0c6f],
  // Kannada
  [0x0c82, 0x0c83], [0x0c85, 0x0c8c], [0x0c8e, 0x0c90],
  [0x0c92, 0x0ca8], [0x0caa, 0x0cb3], [0x0cb5, 0x0cb9],
  [0x0cbe, 0x0cc4], [0x0cc6, 0x0cc8], [0x0cca, 0x0ccd],
  [0x0cde, 0x0cde], [0x0ce0, 0x0ce1],
  // Digits (10)
  [0x0ce6, 0x0cef],
  // Malayalam
  [0x0d02, 0x0d03], [0x0d05, 0x0d0c], [0x0d0e, 0x0d10],
  [0x0d12, 0x0d28], [0x0d2a, 0x0d39], [0x0d3e, 0x0d43],
  [0x0d46, 0x0d48], [0x0d4a, 0x0d4d], [0x0d60, 0x0d61],
  // Digits (11)
  [0x0d66, 0x0d6f],
  // Thai, including digits 0x0E50-0x0E59
  [0x0e01, 0x0e3a], [0x0e40, 0x0e5b],
  // Lao (1)
  [0x0e81, 0x0e82], [0x0e84, 0x0e84], [0x0e87, 0x0e88],
  [0x0e8a, 0x0e8a], [0x0e8d, 0x0e8d], [0x0e94, 0x0e97],
  [0x0e99, 0x0e9f], [0x0ea1, 0x0ea3], [0x0ea5, 0x0ea5],
  [0x0ea7, 0x0ea7], [0x0eaa, 0x0eab], [0x0ead, 0x0eae],
  [0x0eb0, 0x0eb9], [0x0ebb, 0x0ebd], [0x0ec0, 0x0ec4],
  [0x0ec6, 0x0ec6], [0x0ec8, 0x0ecd],
  // Digits (12)
  [0x0ed0, 0x0ed9],
  // Lao (2)
  [0x0edc, 0x0edd],
  // Tibetan (1)
  [0x0f00, 0x0f00], [0x0f18, 0x0f19],
  // Digits (13)
  [0x0f20, 0x0f33],
  // Tibetan (2)
  [0x0f35, 0x0f35], [0x0f37, 0x0f37], [0x0f39, 0x0f39],
  [0x0f3e, 0x0f47], [0x0f49, 0x0f69], [0x0f71, 0x0f84],
  [0x0f86, 0x0f8b], [0x0f90, 0x0f95], [0x0f97, 0x0f97],
  [0x0f99, 0x0fad], [0x0fb1, 0x0fb7], [0x0fb9, 0x0fb9],
  // Georgian
  [0x10a0, 0x10c5], [0x10d0, 0x10f6],
  // Latin (3)
  [0x1e00, 0x1e9b], [0x1ea0, 0x1ef9],
  // Greek (2)
  [0x1f00, 0x1f15], [0x1f18, 0x1f1d], [0x1f20, 0x1f45],
  [0x1f48, 0x1f4d], [0x1f50, 0x1f57], [0x1f59, 0x1f59],
  [0x1f5b, 0x1f5b], [0x1f5d, 0x1f5d], [0x1f5f, 0x1f7d],
  [0x1f80, 0x1fb4], [0x1fb6, 0x1fbc],
  // Special characters (4)
  [0x1fbe, 0x1fbe],
  // Greek (3)
  [0x1fc2, 0x1fc4], [0x1fc6, 0x1fcc], [0x1fd0, 0x1fd3],
  [0x1fd6, 0x1fdb], [0x1fe0, 0x1fec], [0x1ff2, 0x1ff4],
  [0x1ff6, 0x1ffc],
  // Special characters (5)
  [0x203f, 0x2040],
  // Latin (4)
  [0x207f, 0x207f],
  // Special characters (6), including Roman numerals 0x2160-0x2182
  [0x2102, 0x2102], [0x2107, 0x2107], [0x210a, 0x2113],
  [0x2115, 0x2115], [0x2118, 0x211d], [0x2124, 0x2124],
  [0x2126, 0x2126], [0x2128, 0x2128], [0x212a, 0x2131],
  [0x2133, 0x2138], [0x2160, 0x2182], [0x3005, 0x3007],
  [0x3021, 0x3029],
  // Hiragana
  [0x3041, 0x3093], [0x309b, 0x309c],
  // Katakana
  [0x30a1, 0x30f6], [0x30fb, 0x30fc],
  // Bopomofo
  [0x3105, 0x312c],
  // CJK Unified Ideographs
  [0x4e00, 0x9fa5],
  // Hangul
  [0xac00, 0xd7a3],
];

/**
 * The digits that may not start a c99name, as inclusive code-point ranges: ASCII 0-9 and
 * the Annex D digit ranges. Same source and commit as C99_ALLOWED_RANGES (its "Apply further
 * restrictions to the prefix" step); every range here is also in C99_ALLOWED_RANGES.
 */
const C99_NON_INITIAL_DIGIT_RANGES: readonly (readonly [number, number])[] = [
  [0x0030, 0x0039],
  [0x0660, 0x0669], [0x06f0, 0x06f9], [0x0966, 0x096f],
  [0x09e6, 0x09ef], [0x0a66, 0x0a6f], [0x0ae6, 0x0aef],
  [0x0b66, 0x0b6f], [0x0be7, 0x0bef], [0x0c66, 0x0c6f],
  [0x0ce6, 0x0cef], [0x0d66, 0x0d6f], [0x0e50, 0x0e59],
  [0x0ed0, 0x0ed9], [0x0f20, 0x0f33],
];

function inRanges(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([first, last]) => codePoint >= first && codePoint <= last);
}

/**
 * The name Swift code must `import` for a SwiftPM target in `directory`: SwiftPM's c99name,
 * computed as `spm_mangledToC99ExtendedIdentifier` does (StringMangling.swift, commit above
 * C99_ALLOWED_RANGES). Two steps over the Unicode scalars (code points, not UTF-16 units):
 * every scalar outside C99_ALLOWED_RANGES becomes `_`; then, if the first scalar is in
 * C99_NON_INITIAL_DIGIT_RANGES, it is replaced by `_` (not prefixed, so '1abc' -> '_abc',
 * as Swift 6.4 `swift package describe --type json` also reports). Only the first scalar is
 * examined. No normalization is applied, so a precomposed 'ï' (U+00EF) is kept but 'i'
 * followed by a combining diaeresis (U+0308) becomes 'i_'. 'mcp-benchmarker' ->
 * 'mcp_benchmarker', 'a.b c' -> 'a_b_c', 'naïve+x' -> 'naïve_x', 'Util' -> 'Util',
 * 'a½b' -> 'a_b', 'aⅣb' -> 'aⅣb'.
 */
export function swiftModuleName(directory: string): string {
  const scalars = Array.from(directory, (ch) => (inRanges(ch.codePointAt(0)!, C99_ALLOWED_RANGES) ? ch : '_'));
  if (scalars.length > 0 && inRanges(scalars[0]!.codePointAt(0)!, C99_NON_INITIAL_DIGIT_RANGES)) scalars[0] = '_';
  return scalars.join('');
}

/**
 * SwiftPM module: the directory after the last `Sources`/`Tests` directory, if one follows.
 * The directory is the id (it decides sameness); the name is its c99name (`swiftModuleName`).
 */
function swiftModule(filePath: string): ModuleOf | null {
  const dirs = dirSegments(filePath);
  let at = -1;
  for (let i = 0; i < dirs.length; i++) if (dirs[i] === 'Sources' || dirs[i] === 'Tests') at = i;
  if (at < 0 || at + 1 >= dirs.length) return null;
  const dir = dirs[at + 1]!;
  return { id: dir, name: swiftModuleName(dir) };
}

/** A workspace member: its directory (no trailing '/', '' for the root) and its crate name. */
interface CargoMember {
  dir: string;
  name: string;
}

/**
 * The Cargo workspace members of the project at `projectRoot`, longest directory first, so
 * the first member whose `dir + '/'` prefixes a path is that file's crate. Empty when the
 * project has no root workspace.
 */
function cargoMembers(projectRoot: string): CargoMember[] {
  const root = path.resolve(projectRoot);
  // getCargoWorkspaceCrateMap reads only `readFile` and `listDirectories` (both relative to
  // the project root); this is a read-only index, so there is no ReferenceResolver and its
  // context to borrow. The cast is safe for exactly those two members and nothing else.
  const context = {
    readFile: (relPath: string): string | null => {
      try {
        return fs.readFileSync(path.join(root, relPath), 'utf8');
      } catch {
        return null;
      }
    },
    listDirectories: (relPath: string): string[] => {
      const target = relPath === '.' || relPath === '' ? root : path.join(root, relPath);
      try {
        return fs.readdirSync(target, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return [];
      }
    },
  } as unknown as ResolutionContext;
  // The map holds both the `a-b` and `a_b` alias of each package; both name one directory.
  const byDir = new Map<string, string>();
  for (const [alias, member] of getCargoWorkspaceCrateMap(context)) {
    let dir = member.replace(/^(\.\/)+/, '');
    if (dir === '.') dir = '';
    byDir.set(dir, alias.replace(/-/g, '_'));
  }
  return [...byDir].map(([dir, name]) => ({ dir, name })).sort((a, b) => b.dir.length - a.dir.length);
}

/** Rust crate: the longest workspace member directory containing the file, or unknown. */
function rustCrate(filePath: string, members: readonly CargoMember[]): ModuleOf | null {
  const file = filePath.replace(/\\/g, '/');
  for (const m of members) {
    if (m.dir === '' || file.startsWith(`${m.dir}/`)) return { id: m.dir, name: m.name };
  }
  return null;
}

function moduleOf(language: string, filePath: string, members: readonly CargoMember[]): ModuleOf | null {
  if (language === 'swift') return swiftModule(filePath);
  if (language === 'rust') return rustCrate(filePath, members);
  return null;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function orderFlags(flags: Set<SuspectFlag>): SuspectFlag[] {
  return FLAG_ORDER.filter((f) => flags.has(f));
}

function scoreOf(flags: readonly SuspectFlag[]): number {
  return flags.reduce((sum, f) => sum + FLAG_WEIGHT[f], 0);
}

/** findSuspects over an already-open database; `projectRoot` is where the Cargo workspace is read. */
export function findSuspectsInDb(db: SqliteDatabase, projectRoot: string, options: SuspectOptions = {}): Suspect[] {
  const isStd = options.isStdMethod ?? stdCollision;
  const maxEdges = options.maxEdgesPerTarget ?? DEFAULT_MAX_EDGES_PER_TARGET;
  const members = cargoMembers(projectRoot);

  const definitionsStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM nodes WHERE name = ? AND language = ? AND kind IN ('function', 'method')`,
  );
  const importsStmt = db.prepare(`SELECT name FROM nodes WHERE kind = 'import' AND file_path = ?`);
  const definitionsCache = new Map<string, number>();
  const importsCache = new Map<string, string[]>();

  const definitionsOf = (name: string, language: string): number => {
    const key = `${language}\0${name}`;
    let n = definitionsCache.get(key);
    if (n === undefined) {
      n = Number((definitionsStmt.get(name, language) as { n: number }).n);
      definitionsCache.set(key, n);
    }
    return n;
  };
  const importsOf = (file: string): string[] => {
    let names = importsCache.get(file);
    if (!names) {
      names = (importsStmt.all(file) as Array<{ name: string }>).map((r) => r.name);
      importsCache.set(file, names);
    }
    return names;
  };

  const missingImport = (row: CandidateRow): boolean => {
    if (row.callerLanguage !== row.targetLanguage) return false;
    const language = row.targetLanguage;
    const from = moduleOf(language, row.callerFile, members);
    const to = moduleOf(language, row.targetFile, members);
    if (!from || !to || from.id === to.id) return false;
    const imports = importsOf(row.callerFile);
    if (language === 'swift') {
      return !imports.some((name) => name.split('.')[0] === to.name);
    }
    // rust
    if (row.refName !== null && row.refName.startsWith(`${to.name}::`)) return false;
    return !imports.includes(to.name);
  };

  interface Group { suspect: Suspect; scored: Array<{ edge: SuspectEdge; score: number }> }
  const groups = new Map<string, Group>();

  for (const row of db.prepare(CANDIDATE_SQL).all() as CandidateRow[]) {
    const confidence = Number(row.confidence);
    let group = groups.get(row.targetId);
    if (!group) {
      group = {
        suspect: {
          targetId: row.targetId,
          targetName: row.targetName,
          targetQualifiedName: row.targetQualifiedName,
          targetKind: row.targetKind,
          targetFile: row.targetFile,
          targetLine: row.targetLine,
          language: row.targetLanguage,
          flags: [],
          definitions: definitionsOf(row.targetName, row.targetLanguage),
          score: 0,
          edgeCount: 0,
          edges: [],
        },
        scored: [],
      };
      groups.set(row.targetId, group);
    }
    const flags = new Set<SuspectFlag>();
    if (isStd(row.targetLanguage, row.targetName)) flags.add('std-collision');
    if (missingImport(row)) flags.add('missing-import');
    if (group.suspect.definitions > 1) flags.add('several-definitions');
    if (confidence < LOW_CONFIDENCE) flags.add('low-confidence');
    const ordered = orderFlags(flags);
    group.scored.push({
      score: scoreOf(ordered),
      edge: {
        callerId: row.callerId,
        callerName: row.callerName,
        callerFile: row.callerFile,
        line: row.line ?? null,
        refName: row.refName ?? null,
        resolvedBy: row.resolvedBy,
        confidence,
        flags: ordered,
      },
    });
  }

  const suspects: Suspect[] = [];
  for (const { suspect, scored } of groups.values()) {
    scored.sort((a, b) =>
      b.score - a.score
      || compareText(a.edge.callerFile, b.edge.callerFile)
      || (a.edge.line ?? Number.MAX_SAFE_INTEGER) - (b.edge.line ?? Number.MAX_SAFE_INTEGER)
      || compareText(a.edge.callerId, b.edge.callerId));
    const union = new Set<SuspectFlag>();
    for (const { edge } of scored) for (const f of edge.flags) union.add(f);
    suspect.flags = orderFlags(union);
    suspect.score = scored.reduce((max, s) => Math.max(max, s.score), 0);
    suspect.edgeCount = scored.length;
    suspect.edges = scored.slice(0, Math.max(0, maxEdges)).map((s) => s.edge);
    suspects.push(suspect);
  }

  suspects.sort((a, b) =>
    b.score - a.score
    || b.edgeCount - a.edgeCount
    || compareText(a.targetQualifiedName, b.targetQualifiedName)
    || compareText(a.targetId, b.targetId));
  return options.limit === undefined ? suspects : suspects.slice(0, Math.max(0, options.limit));
}

/** Suspect call edges of the project at `projectRoot`, read from its index read-only. */
export function findSuspects(projectRoot: string, options: SuspectOptions = {}): Suspect[] {
  const conn = DatabaseConnection.open(getDatabasePath(projectRoot), { readOnly: true });
  try {
    return findSuspectsInDb(conn.getDb(), projectRoot, options);
  } finally {
    conn.close();
  }
}

/**
 * Text report: a header line, one rank line per target, and its listed edges indented.
 * An empty flag list prints as an empty field; a missing line prints `?`, a missing refName `-`.
 */
export function formatSuspects(suspects: Suspect[]): string {
  if (suspects.length === 0) return 'No suspect call edges.';
  const total = suspects.reduce((sum, s) => sum + s.edgeCount, 0);
  const lines = [`${suspects.length} suspect targets (${total} call edges)`];
  suspects.forEach((s, i) => {
    lines.push(
      `${i + 1}. [score ${s.score}] ${s.targetQualifiedName}  ${s.targetFile}:${s.targetLine}  ` +
      `${s.edgeCount} call(s)  ${s.flags.join(', ')}  defs=${s.definitions}`,
    );
    for (const e of s.edges) {
      lines.push(
        `    ${e.callerName}  ${e.callerFile}:${e.line ?? '?'}  ${e.refName ?? '-'}  ${e.resolvedBy} ${String(e.confidence)}`,
      );
    }
  });
  return lines.join('\n');
}

/** The JSON form: `{ version: 1, suspects }`. */
export function suspectsToJson(suspects: Suspect[]): { version: 1; suspects: Suspect[] } {
  return { version: 1, suspects };
}
