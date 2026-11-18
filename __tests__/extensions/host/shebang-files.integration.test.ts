// R-49: these tests remain red until Orc's extraction hook-in lands;
// see /Users/bob/devlop/team-codegraph/workcrews/host/ledger/reports/r49-shebang-hookin-lines.md.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../../../src';
import { scanDirectory } from '../../../src/extraction';
import { detectLanguage, isSourceFile } from '../../../src/extraction/grammars';
import { clearProjectConfigCache } from '../../../src/project-config';

describe.each(['plain folder', 'git repository'])('extensionless scripts in a %s', (kind) => {
  let root: string;

  beforeEach(() => {
    clearProjectConfigCache();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-shebang-project-')));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin/tool'), '#!/usr/bin/env python3\ndef main():\n    return 1\n');
    fs.writeFileSync(path.join(root, 'bin/serve'), '#!/usr/bin/env node\nfunction serve() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'bin/plain'), 'def plain():\n    return 1\n');
    fs.writeFileSync(path.join(root, 'bin/shell'), '#!/bin/sh\necho hi\n');
    fs.writeFileSync(path.join(root, 'bin/blob'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
    if (kind === 'git repository') {
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['add', '-A'], { cwd: root });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: root });
    }
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['bin/tool', true], ['bin/serve', true], ['bin/plain', false],
    ['bin/shell', false], ['bin/blob', false],
  ])('classifies %s as source: %s', (file, expected) => {
    expect(isSourceFile(file, undefined, root)).toBe(expected);
  });

  it.each([
    ['bin/tool', 'python'], ['bin/serve', 'javascript'], ['bin/plain', 'unknown'],
    ['bin/shell', 'unknown'], ['bin/blob', 'unknown'],
  ])('detects the language of %s as %s', (file, expected) => {
    expect(detectLanguage(file, undefined, undefined, root)).toBe(expected);
  });

  it('scans recognized scripts but not plain text, shell or binary files', () => {
    const files = scanDirectory(root);
    expect(files).toContain('bin/tool');
    expect(files).toContain('bin/serve');
    expect(files).not.toContain('bin/plain');
    expect(files).not.toContain('bin/shell');
    expect(files).not.toContain('bin/blob');
  });

  it('indexes the Python main function in the graph', async () => {
    const cg = await CodeGraph.init(root);
    try {
      expect((await cg.indexAll()).success).toBe(true);
      expect(cg.getNodesInFile('bin/tool')).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'main', kind: 'function', language: 'python' }),
      ]));
    } finally {
      cg.close();
    }
  });
});
