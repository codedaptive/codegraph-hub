import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import picomatch from 'picomatch';

export type TestGroup = 'unit' | 'integration' | 'validation';
export type GroupSelection = TestGroup | 'all';
export interface TestGroupManifest {
  integration: string[];
  validation: string[];
}

// The same manifest classifies every file; retain compiled globs without keeping
// manifests alive after a config load finishes.
const compiledManifests = new WeakMap<TestGroupManifest, {
  integration: picomatch.Matcher;
  validation: picomatch.Matcher;
}>();

export function parseTestGroup(value: string | undefined): GroupSelection {
  switch (value) {
    case undefined:
    case '':
    case 'unit':
      return 'unit';
    case 'integration':
    case 'validation':
    case 'all':
      return value;
    default:
      throw new Error(`Unknown test group ${JSON.stringify(value)}; allowed: unit, integration, validation, all`);
  }
}

/** Read group globs, allowing $comment so the JSON manifest can explain its entries. */
export function readTestGroupManifest(file: string): TestGroupManifest {
  const result: TestGroupManifest = { integration: [], validation: [] };
  if (!existsSync(file)) return result;

  const manifest: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error(`Invalid test group manifest ${file}: expected an object`);
  }
  for (const [key, value] of Object.entries(manifest)) {
    if (key === '$comment') continue;
    if (key !== 'integration' && key !== 'validation') {
      throw new Error(`Invalid test group manifest ${file}: unknown key ${key}`);
    }
    if (!Array.isArray(value) || !value.every((entry: unknown) => typeof entry === 'string')) {
      throw new Error(`Invalid test group manifest ${file}: ${key} must be a string array`);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Classify by suffix first, then manifest globs, then unit. For files without a
 * recognized suffix, matching both manifest lists throws rather than choosing a group.
 */
export function groupOf(file: string, manifest: TestGroupManifest): TestGroup {
  if (file.endsWith('.integration.test.ts') || file.endsWith('.gate.test.ts')) return 'integration';
  if (file.endsWith('.validation.test.ts')) return 'validation';

  let matchers = compiledManifests.get(manifest);
  if (!matchers) {
    matchers = {
      integration: picomatch(manifest.integration),
      validation: picomatch(manifest.validation),
    };
    compiledManifests.set(manifest, matchers);
  }
  const integration = matchers.integration(file);
  const validation = matchers.validation(file);
  if (integration && validation) {
    throw new Error(`Test file ${file} matches both integration and validation in the manifest`);
  }
  if (integration) return 'integration';
  if (validation) return 'validation';
  return 'unit';
}

export function listTestFiles(root: string): string[] {
  const files: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) {
        visit(posix.join(directory, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        files.push(posix.join(directory, entry.name));
      }
    }
  }
  visit('__tests__');
  return files.sort();
}

/**
 * All leaves include unchanged; unit excludes non-unit files to retain the broad
 * include. Integration and validation include only their matching files so the
 * resolved config can replace the inherited broad include; all excludes nothing.
 */
export function engineSelection(
  selection: GroupSelection,
  files: string[],
  manifest: TestGroupManifest,
): { include?: string[]; exclude: string[] } {
  if (selection === 'all') return { exclude: [] };
  if (selection === 'unit') {
    return { exclude: files.filter((file) => groupOf(file, manifest) !== 'unit') };
  }
  return {
    include: files.filter((file) => groupOf(file, manifest) === selection),
    exclude: [],
  };
}
