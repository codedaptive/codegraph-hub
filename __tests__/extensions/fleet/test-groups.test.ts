import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVitest } from 'vitest/node';
import {
  engineSelection,
  groupOf,
  listTestFiles,
  parseTestGroup,
  readTestGroupManifest,
} from '../../../test-groups.mts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const emptyManifest = { integration: [], validation: [] };

let tempRoot: string;
beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'codegraph-test-groups-'));
});
afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('parseTestGroup', () => {
  it.each([undefined, ''])('defaults %s to unit', (value) => {
    expect(parseTestGroup(value)).toBe('unit');
  });

  it.each(['unit', 'integration', 'validation', 'all'] as const)(
    'accepts %s', (value) => {
      expect(parseTestGroup(value)).toBe(value);
    },
  );

  it('names an invalid value and all allowed values in the error', () => {
    expect(() => parseTestGroup('bogus')).toThrowError(
      /(?=.*bogus)(?=.*unit)(?=.*integration)(?=.*validation)(?=.*all)/s,
    );
  });
});

describe('groupOf', () => {
  it.each([
    ['__tests__/a.integration.test.ts', 'integration'],
    ['__tests__/a.gate.test.ts', 'integration'],
    ['__tests__/a.validation.test.ts', 'validation'],
  ] as const)('classifies the suffix of %s as %s', (file, group) => {
    expect(groupOf(file, emptyManifest)).toBe(group);
  });

  it.each([
    ['__tests__/a.integration.test.ts', 'integration'],
    ['__tests__/a.gate.test.ts', 'integration'],
    ['__tests__/a.validation.test.ts', 'validation'],
  ] as const)('lets the suffix of %s override the opposite manifest group', (file, group) => {
    const manifest = group === 'validation'
      ? { integration: [file], validation: [] }
      : { integration: [], validation: [file] };
    expect(groupOf(file, manifest)).toBe(group);
  });

  it('matches an exact manifest path', () => {
    expect(groupOf('__tests__/one.test.ts', {
      integration: ['__tests__/one.test.ts'], validation: [],
    })).toBe('integration');
    expect(groupOf('__tests__/other.test.ts', {
      integration: ['__tests__/one.test.ts'], validation: [],
    })).toBe('unit');
  });

  it('matches a manifest glob', () => {
    expect(groupOf('__tests__/foo/nested/one.test.ts', {
      integration: [], validation: ['__tests__/foo/**'],
    })).toBe('validation');
  });

  it.each(['__tests__/plain.test.ts', '__tests__/plain.unit.test.ts'])(
    'defaults unlisted %s to unit', (file) => {
      expect(groupOf(file, emptyManifest)).toBe('unit');
    },
  );

  it('throws naming a file matched by both manifest lists', () => {
    const file = '__tests__/foo/one.test.ts';
    expect(() => groupOf(file, {
      integration: [file], validation: ['__tests__/foo/**'],
    })).toThrow(file);
  });
});

describe('readTestGroupManifest', () => {
  it('returns empty groups for a missing file', () => {
    expect(readTestGroupManifest(join(tempRoot, 'missing.json'))).toEqual(emptyManifest);
  });

  it.each([
    [{ integration: ['a'] }, { integration: ['a'], validation: [] }],
    [{ validation: ['b'] }, { integration: [], validation: ['b'] }],
    [{}, emptyManifest],
  ])('defaults absent keys to empty arrays', (input, expected) => {
    const file = join(tempRoot, 'groups.json');
    writeFileSync(file, JSON.stringify(input));
    expect(readTestGroupManifest(file)).toEqual(expected);
  });

  it.each([
    { integration: 'a' },
    { validation: null },
    { integration: ['a', 42] },
    { validation: [false] },
  ])('rejects a non-string-array group and names the file', (input) => {
    const file = join(tempRoot, 'groups.json');
    writeFileSync(file, JSON.stringify(input));
    expect(() => readTestGroupManifest(file)).toThrow(file);
  });

  it('rejects unknown keys and names the file', () => {
    const file = join(tempRoot, 'groups.json');
    writeFileSync(file, JSON.stringify({ unit: [] }));
    expect(() => readTestGroupManifest(file)).toThrow(file);
  });

  it('allows the $comment key', () => {
    const file = join(tempRoot, 'groups.json');
    writeFileSync(file, JSON.stringify({ $comment: 'test groups', integration: ['a'] }));
    expect(readTestGroupManifest(file)).toEqual({ integration: ['a'], validation: [] });
  });
});

describe('listTestFiles', () => {
  it('returns sorted relative posix test paths recursively, skipping node_modules', () => {
    for (const path of [
      '__tests__/z.test.ts',
      '__tests__/nested/b.test.ts',
      '__tests__/nested/a.test.ts',
      '__tests__/nested/not-test.ts',
      '__tests__/nested/wrong.test.js',
      '__tests__/node_modules/hidden.test.ts',
      '__tests__/nested/node_modules/deep/hidden.test.ts',
      'outside.test.ts',
    ]) {
      const file = join(tempRoot, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '');
    }
    expect(listTestFiles(tempRoot)).toEqual([
      '__tests__/nested/a.test.ts',
      '__tests__/nested/b.test.ts',
      '__tests__/z.test.ts',
    ]);
  });
});

describe('engineSelection', () => {
  const files = [
    '__tests__/plain.test.ts',
    '__tests__/one.integration.test.ts',
    '__tests__/legacy.test.ts',
    '__tests__/checks/one.test.ts',
    '__tests__/two.validation.test.ts',
  ];
  const manifest = {
    integration: ['__tests__/legacy.test.ts'],
    validation: ['__tests__/checks/**'],
  };
  const integration = [files[1], files[2]];
  const validation = [files[3], files[4]];

  it('leaves the config include unchanged for all', () => {
    expect(engineSelection('all', files, manifest)).toEqual({ exclude: [] });
  });

  it('excludes every non-unit file for unit without setting include', () => {
    expect(engineSelection('unit', files, manifest)).toEqual({
      exclude: [files[1], files[2], files[3], files[4]],
    });
  });

  it('includes exactly the integration files for integration', () => {
    expect(engineSelection('integration', files, manifest)).toEqual({ include: integration, exclude: [] });
  });

  it('includes exactly the validation files for validation', () => {
    expect(engineSelection('validation', files, manifest)).toEqual({ include: validation, exclude: [] });
  });

  it('partitions all files into exactly one group', () => {
    const unit = engineSelection('unit', files, manifest);
    const integrationSelection = engineSelection('integration', files, manifest);
    const validationSelection = engineSelection('validation', files, manifest);
    const groups = [
      files.filter((file) => !unit.exclude.includes(file)),
      integrationSelection.include ?? [],
      validationSelection.include ?? [],
    ];
    expect(groups.flat().sort()).toEqual([...files].sort());
    for (const file of files) {
      expect(groups.filter((group) => group.includes(file))).toHaveLength(1);
    }
  });
});

// slow: each case loads the real vitest.config.mts through createVitest (in process, no spawn); the first
// load bundles the config and its imports (measured 4.8 s at load average 80; later loads under 1 s).
describe('vitest.config.mts engine selection', () => {
  const files = listTestFiles(repoRoot);
  const manifest = readTestGroupManifest(join(repoRoot, 'test-groups.json'));

  async function engineFiles(group: string | undefined): Promise<string[]> {
    const previous = process.env.CODEGRAPH_TEST_GROUP;
    if (group === undefined) delete process.env.CODEGRAPH_TEST_GROUP;
    else process.env.CODEGRAPH_TEST_GROUP = group;
    try {
      const ctx = await createVitest('test', {
        config: join(repoRoot, 'vitest.config.mts'),
        root: repoRoot,
        watch: false,
        project: ['engine'],
      });
      try {
        const specs = await ctx.globTestSpecifications();
        return specs.filter((spec) => spec.project.name === 'engine')
          .map((spec) => relative(repoRoot, spec.moduleId).split(sep).join('/'))
          .sort();
      } finally {
        await ctx.close();
      }
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_TEST_GROUP;
      else process.env.CODEGRAPH_TEST_GROUP = previous;
    }
  }

  it('selects exactly the integration files', async () => {
    const selected = await engineFiles('integration');
    expect(selected).toEqual(engineSelection('integration', files, manifest).include);
    expect(selected).toContain('__tests__/function-ref.test.ts');
  });

  it('selects exactly the validation files', async () => {
    const selected = await engineFiles('validation');
    expect(selected).toEqual(engineSelection('validation', files, manifest).include);
    for (const file of files.filter((file) => file.endsWith('.validation.test.ts'))) {
      expect(selected, file).toContain(file);
    }
    for (const entry of manifest.validation) {
      // Wrapped: Array.some's index argument would reach picomatch's returnObject parameter.
      const matches = picomatch(entry);
      expect(selected.some((file) => matches(file)), `manifest entry ${entry}`).toBe(true);
    }
  });

  it.each([['unit', 'unit'], ['unset', undefined]] as const)(
    'selects unit files for %s and excludes every seeded file', async (_label, group) => {
      const selected = await engineFiles(group);
      const excluded = engineSelection('unit', files, manifest).exclude;
      expect(selected).toEqual(files.filter((file) =>
        file !== '__tests__/ui-package.test.ts' && !excluded.includes(file)));
      for (const entry of [...manifest.integration, ...manifest.validation]) {
        // Wrapped: Array.some's index argument would reach picomatch's returnObject parameter.
        const matches = picomatch(entry);
        expect(selected.some((file) => matches(file)), `manifest entry ${entry}`).toBe(false);
      }
    },
  );

  it('selects all engine files for all', async () => {
    expect(await engineFiles('all')).toEqual(
      files.filter((file) => file !== '__tests__/ui-package.test.ts'),
    );
  });
});

describe('real test-group seed', () => {
  it('has at least one real test file matching every manifest entry', () => {
    const manifest = readTestGroupManifest(join(repoRoot, 'test-groups.json'));
    const files = listTestFiles(repoRoot);
    for (const entry of [...manifest.integration, ...manifest.validation]) {
      const matches = picomatch(entry);
      expect(files.some((file) => matches(file)), `manifest entry ${entry}`).toBe(true);
    }
  });

  it.each([
    ['__tests__/daemon-older-version.test.ts', 'validation'],
    ['__tests__/mcp-ppid-watchdog.test.ts', 'validation'],
    ['__tests__/add-lang-check-grammar.test.ts', 'integration'],
    ['__tests__/status-index-health.test.ts', 'validation'],
    ['__tests__/function-ref.test.ts', 'integration'],
    ['__tests__/frontload-hook.test.ts', 'validation'],
    ['__tests__/liveness-watchdog.test.ts', 'integration'],
    ['__tests__/ui-trails.test.ts', 'integration'],
    ['__tests__/ui-highlight.test.ts', 'validation'],
  ] as const)('assigns seeded %s to %s', (file, group) => {
    const manifest = readTestGroupManifest(join(repoRoot, 'test-groups.json'));
    expect(listTestFiles(repoRoot)).toContain(file);
    expect(groupOf(file, manifest)).toBe(group);
  });
});
