import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { swiftExtendedConformances } from '../../../src/resolution/swift-type-visibility';
import type { ResolutionContext } from '../../../src/resolution/types';
import type { Node } from '../../../src/types';

const extensions = `extension String {}
extension CodingKey {}
extension P {}
extension View {}
extension Sendable {}
extension Container {}
`;
let root: string;
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-swift-nested-supertypes-'));
  fs.writeFileSync(path.join(root, 'Extensions.swift'), extensions);
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function conformances(source: string, name: string, kind: Node['kind'] = 'struct', startLine = 1, startColumn = 0): string[] {
  const node: Node = {
    id: `subject:${name}`, name, qualifiedName: name, kind, language: 'swift',
    filePath: 'Subject.swift', startLine, startColumn,
    endLine: source.split('\n').length, endColumn: 0, updatedAt: 0,
  };
  const context: ResolutionContext = {
    getNodesInFile: (file) => cg.getNodesInFile(file),
    getNodesByName: (target) => cg.getNodesByName(target),
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: (file) => file === 'Subject.swift' || file === 'Extensions.swift',
    readFile: (file) => file === 'Subject.swift' ? source : file === 'Extensions.swift' ? extensions : null,
    getProjectRoot: () => root,
    getAllFiles: () => ['Subject.swift', 'Extensions.swift'],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
  };
  return swiftExtendedConformances(node, context);
}

const nested = `struct User {
    enum CodingKeys: String, CodingKey {
        case name
    }
}`;

describe('Swift declaration supertypes', () => {
  it('does not assign a nested enum’s supertypes to its enclosing struct', () => {
    expect(conformances(nested, 'User')).toEqual([]);
  });

  it('ignores a declaration in an attribute argument before the keyword', () => {
    expect(conformances('@Wrap({ struct Fake: P {} })\nstruct Plain {}', 'Plain')).toEqual([]);
  });

  it('ignores a declaration in a comment before the keyword', () => {
    expect(conformances('@MainActor /* struct Fake: P { */ struct Plain {}', 'Plain')).toEqual([]);
  });

  it('ignores a declaration inside a nested block comment before the keyword', () => {
    expect(conformances('@MainActor /* outer /* inner */ struct Fake: P { */ struct Plain {}', 'Plain')).toEqual([]);
  });

  it('reads the real supertype past an escaped quote and declaration in a string', () => {
    expect(conformances(String.raw`@Doc("say \"struct Fake: View {\" here") struct Real: P {}`, 'Real')).toEqual(['P']);
  });

  it('reads the real supertype past a declaration and quote in a multiline string', () => {
    expect(conformances(`@Doc("""
struct Fake: View { and a "
""") struct Real: P {}`, 'Real')).toEqual(['P']);
  });

  it('reads the real supertype past declarations in raw strings', () => {
    expect(conformances(String.raw`@Doc(#"\" struct Fake: View {"#) struct Real: P {}`, 'Real')).toEqual(['P']);
    expect(conformances(`@Doc(#"""
struct Fake: View { and a "
"""#) struct Real: P {}`, 'Real')).toEqual(['P']);
  });

  it('reads the real supertype past a line comment containing a declaration and quote', () => {
    expect(conformances('@MainActor // struct Fake: View { and a "\nstruct Real: P {}', 'Real')).toEqual(['P']);
  });

  it('does not treat a line comment marker inside a string as a comment', () => {
    expect(conformances('@Doc("http://x struct Fake: View {") struct Real: P {}', 'Real')).toEqual(['P']);
  });

  it('retains the nested enum’s own supertypes', () => {
    expect(conformances(nested, 'CodingKeys', 'enum', 2, 4)).toEqual(['String', 'CodingKey']);
  });

  it('reads both supertypes from a single-line declaration', () => {
    expect(conformances('struct HomeView: View, Sendable {}', 'HomeView')).toEqual(['View', 'Sendable']);
  });

  it('reads a multi-line inheritance head', () => {
    expect(conformances('struct HomeView:\n    View,\n    Sendable\n{}', 'HomeView')).toEqual(['View', 'Sendable']);
  });

  it('reads the supertype following a generic parameter constraint', () => {
    expect(conformances('struct Box<T: Equatable>: Container {}', 'Box')).toEqual(['Container']);
  });

  it('reads the supertype before a where clause', () => {
    expect(conformances('extension Box: Sendable where T: Sendable {}', 'Box', 'class')).toEqual(['Sendable']);
  });

  it('reads a supertype after an attribute containing braces', () => {
    expect(conformances('@Wrap({ x in x })\nstruct Q: P {}', 'Q')).toEqual(['P']);
  });
});
