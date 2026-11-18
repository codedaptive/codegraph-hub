/**
 * Orphans on a real index of a Rust git fixture. C2 adds unreferenced functions
 * in a cfg(test) out-of-line module, a plain module and an inline cfg(all)
 * module. Fixture checks establish the nodes before classification checks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../../../src';
import { DatabaseConnection, getDatabasePath } from '../../../src/db';
import { runOrphans } from '../../../src/extensions/queries/orphans/index';

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', [
    '-c', 'user.name=orphans-test', '-c', 'user.email=orphans-test@example.invalid',
    '-c', 'commit.gpgsign=false', ...args,
  ], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function write(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

interface NodeRow { name: string; kind: string; file_path: string }
interface Entry { name: string; path: string; kind: string }
interface OrphansJson { orphans: Entry[]; guessed: Entry[] }

describe('orphans Rust test configuration', () => {
  let root = '';
  let report: OrphansJson;
  let nodes: NodeRow[] = [];

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphans-rust-cfg-')));
    git(root, 'init', '-q');
    write(root, 'Cargo.toml', '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n');
    write(root, 'src/lib.rs', 'pub mod store;\npub mod plain;\npub mod inline;\n');
    write(root, 'src/store.rs', '#[cfg(test)]\nmod tests;\n');
    write(root, 'src/plain.rs', 'mod tests;\n');
    write(root, 'src/inline.rs', '');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'C1');
    git(root, 'tag', 'C1');
    write(root, 'src/store/tests.rs', 'fn fixture_helper() -> u32 {\n    1\n}\n');
    write(root, 'src/plain/tests.rs', 'fn plain_helper() -> u32 {\n    2\n}\n');
    write(root, 'src/inline.rs', '#[cfg(all(test, feature = "x"))]\nmod t {\n    fn inline_helper() -> u32 {\n        3\n    }\n}\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'C2');

    const cg = await CodeGraph.init(root);
    await cg.indexAll();
    cg.close();
    const conn = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
    try {
      nodes = conn.getDb().prepare('SELECT name, kind, file_path FROM nodes').all() as unknown as NodeRow[];
    } finally {
      conn.close();
    }
    const result = await runOrphans(root, { base: 'C1', format: 'json' });
    expect(result.exitCode, result.stderr).toBe(0);
    report = JSON.parse(result.output) as OrphansJson;
  }, 30_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('fixture: all three unreferenced functions are indexed at their Rust paths', () => {
    expect(nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'fixture_helper', kind: 'function', file_path: 'src/store/tests.rs' }),
      expect.objectContaining({ name: 'plain_helper', kind: 'function', file_path: 'src/plain/tests.rs' }),
      expect.objectContaining({ name: 'inline_helper', kind: 'function', file_path: 'src/inline.rs' }),
    ]));
  });

  it('excludes an unreferenced function in a cfg(test) out-of-line module', () => {
    expect([...report.orphans, ...report.guessed]).not.toContainEqual(
      expect.objectContaining({ name: 'fixture_helper', path: 'src/store/tests.rs' }),
    );
  });

  it('excludes an unreferenced function in an inline cfg(all(test, ...)) module', () => {
    expect([...report.orphans, ...report.guessed]).not.toContainEqual(
      expect.objectContaining({ name: 'inline_helper', path: 'src/inline.rs' }),
    );
  });

  it('lists an unreferenced function in a plain out-of-line module', () => {
    expect(report.orphans).toContainEqual(
      expect.objectContaining({ name: 'plain_helper', path: 'src/plain/tests.rs', kind: 'function' }),
    );
  });
});
