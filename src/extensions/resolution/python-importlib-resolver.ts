/**
 * Links a Python module to the files it loads by path with importlib
 * (`SourceFileLoader`, `spec_from_file_location`), as a file-level `imports` edge.
 *
 * Why: a test that loads a script by path depends on it, and no import statement says
 * so; without the edge the file's dependents miss the test (ruling R-49(b)).
 *
 * extract() emits one reference per path pythonLoaderPaths finds, named by the path
 * alone and carrying no candidates: an edge resurrected after its target is deleted
 * and re-added keeps only the name (src/resolution/resurrect-ref.ts). A name with a
 * leading '/' is anchored on `__file__` and is root-relative; any other name is tried
 * root-relative first, then relative to the loading file's directory.
 *
 * resolve() runs for each Python reference that reaches framework resolution (after the
 * name pre-filter); one that is not a loader's returns null after a test of its own
 * fields and no context call. ownsReference keeps the import and name strategies from
 * guessing a module for a path no file answers.
 */
import * as path from 'path';
import type { FrameworkResolver, ResolutionContext, UnresolvedRef } from '../../resolution/types';
import { pythonLoaderPaths } from './python-loader-paths';

function isLoaderRef(ref: UnresolvedRef): boolean {
  return ref.language === 'python'
    && ref.referenceKind === 'imports'
    && ref.fromNodeId === `file:${ref.filePath}`
    && ref.referenceName.includes('/');
}

function candidates(ref: UnresolvedRef): string[] {
  const name = ref.referenceName;
  if (name.startsWith('/')) return [name.slice(1)];
  return [path.posix.normalize(name), path.posix.join(path.posix.dirname(ref.filePath), name)]
    .filter((candidate) => !candidate.startsWith('..'));
}

function fileNodeId(candidate: string, context: ResolutionContext): string | undefined {
  const id = `file:${candidate}`;
  if (context.getNodeById) return context.getNodeById(id)?.id;
  return context.getNodesInFile(candidate).find((node) => node.kind === 'file')?.id;
}

export const pythonImportlibResolver: FrameworkResolver = {
  name: 'python-importlib',
  languages: ['python'],

  detect: (context) => context.getAllFiles().some((file) => file.endsWith('.py')),

  extract: (filePath, content) => ({
    nodes: [],
    references: pythonLoaderPaths(filePath, content).map(({ line, name }) => ({
      fromNodeId: `file:${filePath}`,
      referenceName: name,
      referenceKind: 'imports',
      line,
      column: 0,
      filePath,
      language: 'python',
    })),
  }),

  claimsReference: (name) => name.includes('/'),

  ownsReference: (ref) => isLoaderRef(ref),

  resolve(ref, context) {
    if (!isLoaderRef(ref)) return null;
    for (const candidate of candidates(ref)) {
      const targetNodeId = fileNodeId(candidate, context);
      if (targetNodeId) return { original: ref, targetNodeId, confidence: 0.95, resolvedBy: 'framework' };
    }
    return null;
  },
};
