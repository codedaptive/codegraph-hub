/**
 * Blast on a real index of a Rust git fixture. C2 edits two functions; callers
 * live in separate out-of-line modules declared with and without cfg(test).
 * Fixture checks establish the indexed call edges before classification checks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../../../src';
import { DatabaseConnection, getDatabasePath } from '../../../src/db';
import { runBlast } from '../../../src/extensions/queries/blast/index';
import type { BlastReport } from '../../../src/extensions/queries/blast/blast';

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', [
    '-c', 'user.name=blast-test', '-c', 'user.email=blast-test@example.invalid',
    '-c', 'commit.gpgsign=false', ...args,
  ], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function write(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

interface NodeRow { id: string; name: string; kind: string; file_path: string }
interface EdgeRow { source: string; target: string; kind: string }

describe('blast Rust out-of-line test modules', () => {
  let root = '';
  let report: BlastReport;
  let changedTestsReport: BlastReport;
  let nodes: NodeRow[] = [];
  let edges: EdgeRow[] = [];

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-rust-cfg-')));
    git(root, 'init', '-q');
    write(root, 'Cargo.toml', '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n');
    write(root, 'src/lib.rs', 'pub mod store;\npub mod plain;\n');
    write(root, 'src/store.rs', '#[cfg(test)]\nmod tests;\npub fn open_store() -> u32 {\n    1\n}\n');
    write(root, 'src/plain.rs', 'mod tests;\npub fn open_plain() -> u32 {\n    1\n}\n');
    write(root, 'src/store/tests.rs', 'use super::*;\nfn store_caller() -> u32 {\n    open_store()\n}\n');
    write(root, 'src/plain/tests.rs', 'use super::*;\nfn plain_caller() -> u32 {\n    open_plain()\n}\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'C1');
    git(root, 'tag', 'C1');
    write(root, 'src/store.rs', '#[cfg(test)]\nmod tests;\npub fn open_store() -> u32 {\n    2\n}\n');
    write(root, 'src/plain.rs', 'mod tests;\npub fn open_plain() -> u32 {\n    2\n}\n');
    git(root, 'commit', '-q', '-am', 'C2');

    const cg = await CodeGraph.init(root);
    await cg.indexAll();
    cg.close();
    const conn = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
    try {
      nodes = conn.getDb().prepare('SELECT id, name, kind, file_path FROM nodes').all() as unknown as NodeRow[];
      edges = conn.getDb().prepare('SELECT source, target, kind FROM edges').all() as unknown as EdgeRow[];
    } finally {
      conn.close();
    }
    const result = runBlast(root, { base: 'C1', format: 'json' });
    expect(result.exitCode, result.stderr).toBe(0);
    report = JSON.parse(result.output) as BlastReport;
    write(root, 'src/store/tests.rs', 'use super::*;\nfn store_caller() -> u32 {\n    open_store()\n}\n// changed\n');
    const changedTestsResult = runBlast(root, { base: 'C1', format: 'json' });
    expect(changedTestsResult.exitCode, changedTestsResult.stderr).toBe(0);
    changedTestsReport = JSON.parse(changedTestsResult.output) as BlastReport;
  }, 30_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('fixture: the Rust functions and their cross-file calls are indexed', () => {
    for (const [caller, callerPath, target, targetPath] of [
      ['store_caller', 'src/store/tests.rs', 'open_store', 'src/store.rs'],
      ['plain_caller', 'src/plain/tests.rs', 'open_plain', 'src/plain.rs'],
    ]) {
      const source = nodes.find((n) => n.name === caller && n.file_path === callerPath && n.kind === 'function');
      const dest = nodes.find((n) => n.name === target && n.file_path === targetPath && n.kind === 'function');
      expect(source, caller).toBeDefined();
      expect(dest, target).toBeDefined();
      expect(edges.some((e) => e.kind === 'calls' && e.source === source?.id && e.target === dest?.id), caller).toBe(true);
    }
  });

  it('puts the cfg(test) out-of-line module under testModules, not modules', () => {
    expect(report.testModules.flatMap((m) => m.files)).toContain('src/store/tests.rs');
    expect(report.modules.flatMap((m) => m.files)).not.toContain('src/store/tests.rs');
  });

  it('keeps a plain out-of-line module under modules, not testModules', () => {
    expect(report.modules.flatMap((m) => m.files)).toContain('src/plain/tests.rs');
    expect(report.testModules.flatMap((m) => m.files)).not.toContain('src/plain/tests.rs');
  });

  it('reports an unchanged cfg-test caller as a stale area test', () => {
    const area = report.areas.find((a) => a.key === 'src/');
    expect(area?.testFiles).toContain('src/store/tests.rs');
    expect(area?.tests).toBe('stale');
  });

  it('uses a changed cfg-test caller as a test signal, not an area seed', () => {
    expect(changedTestsReport.areas.flatMap((a) => a.files)).not.toContain('src/store/tests.rs');
    const area = changedTestsReport.areas.find((a) => a.key === 'src/');
    expect(area?.changedTestFiles).toContain('src/store/tests.rs');
    expect(area?.tests).toBe('changed');
  });
});
