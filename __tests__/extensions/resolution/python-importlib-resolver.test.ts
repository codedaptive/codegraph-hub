/**
 * Tests of pythonImportlibResolver with a context that throws on any lookup a test does
 * not stub: detect (`.py` files and extensionless Python scripts), extract (file-level
 * `imports` references named by the path),
 * claimsReference, ownsReference, and resolve (root-relative candidate before
 * loader-relative; none for an anchored name whose root candidate is absent; a
 * root-escaping name drops its root candidate and still tries the loader-relative one;
 * the file-kind fallback when getNodeById is absent).
 */
import { describe, expect, it } from 'vitest';
import { pythonImportlibResolver } from '../../../src/extensions/resolution/python-importlib-resolver';
import type { ResolutionContext, UnresolvedRef } from '../../../src/resolution/types';
import type { Node } from '../../../src/types';

function unexpected(): never {
  throw new Error('unexpected context access');
}

function context(): ResolutionContext {
  return {
    getNodesInFile: unexpected, getNodesByName: unexpected, getNodesByQualifiedName: unexpected,
    getNodesByKind: unexpected, fileExists: unexpected, readFile: unexpected,
    getProjectRoot: unexpected, getAllFiles: unexpected, getNodesByLowerName: unexpected,
    getImportMappings: unexpected, getNodeById: unexpected,
  };
}

function fileNode(filePath: string): Node {
  return {
    id: `file:${filePath}`, name: filePath, qualifiedName: filePath, kind: 'file',
    language: 'python', filePath, startLine: 1, startColumn: 0, endLine: 1, endColumn: 0, updatedAt: 0,
  };
}

const ref: UnresolvedRef = {
  fromNodeId: 'file:tests/unit/test_a.py', referenceName: 'share/x.py', referenceKind: 'imports',
  line: 3, column: 0, filePath: 'tests/unit/test_a.py', language: 'python',
};

describe('pythonImportlibResolver', () => {
  it('identifies itself and detects .py files without reading sources', () => {
    expect(pythonImportlibResolver.name).toBe('python-importlib');
    expect(pythonImportlibResolver.languages).toEqual(['python']);
    expect(pythonImportlibResolver.detect({ ...context(), getAllFiles: () => ['bin/tool', 'src/a.ts', 'tests/a.py'] })).toBe(true);
    expect(pythonImportlibResolver.detect({ ...context(), getAllFiles: () => ['src/a.ts', 'a.py.txt'] })).toBe(false);
  });

  it('detects an extensionless-only Python project', () => {
    const sources: Record<string, string> = {
      'tests/test_tool': '#!/usr/bin/env python3\nfrom importlib.machinery import SourceFileLoader\nSourceFileLoader("subject", "bin/subject").load_module()\n',
      'bin/subject': '#!/usr/bin/env python3\nprint("hi")\n',
    };
    expect(pythonImportlibResolver.detect({
      ...context(), getAllFiles: () => ['tests/test_tool', 'bin/subject'],
      readFile: (file) => sources[file] ?? null,
    })).toBe(true);
  });

  it('rejects extensionless non-Python and unreadable scripts', () => {
    expect(pythonImportlibResolver.detect({
      ...context(), getAllFiles: () => ['bin/run', 'bin/missing'],
      readFile: (file) => file === 'bin/run' ? '#!/bin/sh\necho hi\n' : null,
    })).toBe(false);
  });

  it('does not read files with extensions during detection', () => {
    expect(pythonImportlibResolver.detect({
      ...context(), getAllFiles: () => ['src/a.ts', 'README.md'],
    })).toBe(false);
  });

  it('extracts file-level import references without candidates', () => {
    expect(pythonImportlibResolver.extract?.('tests/unit/test_a.py', `ROOT = Path(__file__).resolve().parents[2]
SourceFileLoader("x", str(ROOT / "share" / "x.py"))
spec_from_file_location("y", "y.py")`)).toEqual({
      nodes: [], references: [
        { fromNodeId: 'file:tests/unit/test_a.py', referenceName: '/share/x.py', referenceKind: 'imports', line: 2, column: 0, filePath: 'tests/unit/test_a.py', language: 'python' },
        { fromNodeId: 'file:tests/unit/test_a.py', referenceName: './y.py', referenceKind: 'imports', line: 3, column: 0, filePath: 'tests/unit/test_a.py', language: 'python' },
      ],
    });
  });

  it.each([['share/x.py', true], ['./x.py', true], ['x.py', false]])('claims slash-bearing name %s', (name, expected) => {
    expect(pythonImportlibResolver.claimsReference?.(name)).toBe(expected);
  });

  it.each([
    ['valid', ref, true],
    ['other language', { ...ref, language: 'typescript' }, false],
    ['other kind', { ...ref, referenceKind: 'calls' }, false],
    ['non-file source', { ...ref, fromNodeId: 'function:tests/unit/test_a.py:load' }, false],
    ['wrong file source', { ...ref, fromNodeId: 'file:other.py' }, false],
    ['no slash', { ...ref, referenceName: 'x.py' }, false],
  ] satisfies Array<[string, UnresolvedRef, boolean]>)('owns only its references: %s', (_label, input, expected) => {
    expect(pythonImportlibResolver.ownsReference?.(input, context())).toBe(expected);
    if (!expected) expect(pythonImportlibResolver.resolve(input, context())).toBeNull();
  });

  it('chooses the root-relative file before the loader-relative file', () => {
    const nodes = [fileNode('share/x.py'), fileNode('tests/unit/share/x.py')];
    expect(pythonImportlibResolver.resolve(ref, {
      ...context(), getNodeById: (id) => nodes.find((node) => node.id === id) ?? null,
    })).toEqual({ original: ref, targetNodeId: 'file:share/x.py', confidence: 0.95, resolvedBy: 'framework' });
  });

  it('falls back to the loader directory when the root candidate is absent', () => {
    const nodes = [fileNode('tests/unit/share/x.py')];
    expect(pythonImportlibResolver.resolve(ref, {
      ...context(), getNodeById: (id) => nodes.find((node) => node.id === id) ?? null,
    })).toEqual({ original: ref, targetNodeId: 'file:tests/unit/share/x.py', confidence: 0.95, resolvedBy: 'framework' });
  });

  it('does not fall back to the loader directory for anchored names', () => {
    const nodes = [fileNode('tests/unit/share/x.py')];
    expect(pythonImportlibResolver.resolve({ ...ref, referenceName: '/share/x.py' }, {
      ...context(), getNodeById: (id) => nodes.find((node) => node.id === id) ?? null,
    })).toBeNull();
  });

  it('drops root-escaping candidates and finds the loader-relative parent', () => {
    const input = { ...ref, referenceName: '../lib/x.py' };
    const nodes = [fileNode('tests/lib/x.py')];
    const visited: string[] = [];
    expect(pythonImportlibResolver.resolve(input, {
      ...context(), getNodeById: (id) => { visited.push(id); return nodes.find((node) => node.id === id) ?? null; },
    })).toEqual({ original: input, targetNodeId: 'file:tests/lib/x.py', confidence: 0.95, resolvedBy: 'framework' });
    expect(visited).toEqual(['file:tests/lib/x.py']);
  });

  it('tries a dot-relative name from the root before the loader directory', () => {
    const input = { ...ref, referenceName: './x.py' };
    const visited: string[] = [];
    expect(pythonImportlibResolver.resolve(input, {
      ...context(), getNodeById: (id) => { visited.push(id); return id === 'file:tests/unit/x.py' ? fileNode('tests/unit/x.py') : null; },
    })).toEqual({ original: input, targetNodeId: 'file:tests/unit/x.py', confidence: 0.95, resolvedBy: 'framework' });
    expect(visited).toEqual(['file:x.py', 'file:tests/unit/x.py']);
  });

  it('uses file-kind nodes when node lookup by id is unavailable', () => {
    const fallback = context();
    delete fallback.getNodeById;
    fallback.getNodesInFile = (file) => file === 'share/x.py' ? [fileNode('share/x.py')] : [];
    expect(pythonImportlibResolver.resolve(ref, fallback)).toEqual({ original: ref, targetNodeId: 'file:share/x.py', confidence: 0.95, resolvedBy: 'framework' });
  });

  it('does not resolve a non-file node in the fallback lookup', () => {
    const fallback = context();
    delete fallback.getNodeById;
    fallback.getNodesInFile = () => [{ ...fileNode('share/x.py'), kind: 'function' }];
    expect(pythonImportlibResolver.resolve(ref, fallback)).toBeNull();
  });
});
