/**
 * Worktree seeding, unit level.
 *
 * A fresh git worktree of a repository that already has an index in one of
 * its other worktrees gets its own index by copying that sibling's database
 * (an APFS clone on macOS, a plain copy elsewhere, or a SQLite backup when the
 * source cannot be fenced) instead of a cold build. These cases pin the git
 * helpers that find the siblings, the rule that picks the source, the set of
 * files a seed copies (and the seed nonce the installed database carries),
 * and that a seed taken while the source is being written is still a sound
 * database.
 *
 * Real `git` against real temp repositories and real SQLite, no mocking. The
 * ToolHandler entry point (the gate a tool call goes through) is covered in
 * worktree-seed.gate.test.ts.
 *
 * Vectors (contract.md): G1 determinism, G4 copy set, G5 source choice,
 * G6 fence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { listGitWorktrees, commitDistance } from '../../../src/extensions/host/worktree-lifecycle/git';
import { pickSeedSource, seedFromSibling, ensureWorktreeIndex } from '../../../src/extensions/host/worktree-lifecycle/seed';
import { readSeedNonce } from '../../../src/extensions/host/worktree-lifecycle/project-registry';
import { BuilderSeedHost } from '../../../src/extensions/host/builder/seed-host';
import { JobQueue } from '../../../src/extensions/host/builder/queue';

// vite's resolver strips the `node:` prefix from an import of node:sqlite,
// so it is loaded with require (as the upstream suites do).
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** realpath, so macOS /var -> /private/var does not break equality. */
function real(p: string): string {
  return fs.realpathSync(path.resolve(p));
}

/** A repository with three tiny TypeScript files, one commit, at `dir`. */
function makeRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'src', 'alpha.ts'), 'export function alphaSymbol() { return betaSymbol(); }\nimport { betaSymbol } from "./beta";\n');
  fs.writeFileSync(path.join(dir, 'src', 'beta.ts'), 'export function betaSymbol() { return 2; }\n');
  fs.writeFileSync(path.join(dir, 'src', 'gamma.ts'), 'export class Gamma { run() { return 3; } }\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

/** Build a complete index at `dir`. */
async function indexDir(dir: string): Promise<void> {
  const cg = await CodeGraph.init(dir);
  await cg.indexAll();
  cg.close();
}

/** Add a linked worktree at `dir` on a new branch from `from` (default HEAD). */
function addWorktree(repo: string, dir: string, branch: string, from = 'HEAD'): void {
  git(repo, 'worktree', 'add', '-q', '-b', branch, dir, from);
}

/** Add `n` commits in the worktree at `dir`, each touching its own file. */
function commitN(dir: string, n: number, tag: string): void {
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(dir, `${tag}-${i}.txt`), `${tag} ${i}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `${tag} ${i}`);
  }
}

function dbPath(root: string): string {
  return path.join(root, '.codegraph', 'codegraph.db');
}

/** The rows an index answers from, in a fixed order: files, nodes, edges. */
function logicalDump(root: string): string {
  const db = new DatabaseSync(dbPath(root), { readOnly: true });
  try {
    return JSON.stringify({
      files: db.prepare('SELECT * FROM files ORDER BY path').all(),
      nodes: db.prepare('SELECT * FROM nodes ORDER BY id').all(),
      edges: db.prepare('SELECT * FROM edges ORDER BY source, target, kind, line, id').all(),
    });
  } finally {
    db.close();
  }
}

describe('worktree seeding: git helpers and source choice (G5)', () => {
  let workspace: string;
  let main: string;

  beforeEach(() => {
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-seed-unit-')));
    main = path.join(workspace, 'main');
    makeRepo(main);
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('listGitWorktrees lists every worktree of the repository, realpath\'d, with its HEAD', async () => {
    const wt = path.join(workspace, 'wt-one');
    addWorktree(main, wt, 'one');
    commitN(wt, 1, 'one');

    const entries = await listGitWorktrees(wt);
    expect(entries).not.toBeNull();
    const byPath = new Map(entries!.map((e) => [e.path, e.head]));
    expect([...byPath.keys()].sort()).toEqual([real(main), real(wt)].sort());
    expect(byPath.get(real(main))).toBe(git(main, 'rev-parse', 'HEAD'));
    expect(byPath.get(real(wt))).toBe(git(wt, 'rev-parse', 'HEAD'));
  });

  it('listGitWorktrees answers null outside a git repository', async () => {
    const plain = path.join(workspace, 'plain');
    fs.mkdirSync(plain);
    expect(await listGitWorktrees(plain)).toBeNull();
  });

  it('commitDistance counts the symmetric difference between two HEADs, null for an unknown commit', async () => {
    const wt = path.join(workspace, 'wt-three');
    addWorktree(main, wt, 'three');
    commitN(wt, 3, 'three');
    commitN(main, 2, 'main');
    const a = git(main, 'rev-parse', 'HEAD');
    const b = git(wt, 'rev-parse', 'HEAD');
    expect(await commitDistance(main, a, b)).toBe(5);
    expect(await commitDistance(main, b, a)).toBe(5);
    expect(await commitDistance(main, a, a)).toBe(0);
    expect(await commitDistance(main, a, '0123456789abcdef0123456789abcdef01234567')).toBeNull();
  });

  // G5. Over 5 s under load: it adds four git worktrees, makes five commits and
  // builds three real indexes (sib-b, sib-3, sib-a), each a few hundred ms on an
  // idle machine. The 30 s bound only catches a hang on a loaded one.
  it('G5: picks the nearest complete sibling, ties broken by realpath ascending', async () => {
    const base = git(main, 'rev-parse', 'HEAD');
    const target = path.join(workspace, 'wt-target');
    addWorktree(main, target, 'target', base);

    // Created in an order that is NOT the answer's order, so a pick by
    // `git worktree list` order or creation order fails.
    const sibB = path.join(workspace, 'sib-b'); // distance 1
    addWorktree(main, sibB, 'sib-b', base);
    commitN(sibB, 1, 'b');
    const sib3 = path.join(workspace, 'sib-3'); // distance 3
    addWorktree(main, sib3, 'sib-3', base);
    commitN(sib3, 3, 'three');
    const sibA = path.join(workspace, 'sib-a'); // distance 1, lexicographically first of the two
    addWorktree(main, sibA, 'sib-a', base);
    commitN(sibA, 1, 'a');
    // Distance 0, but its index never completed (init, no indexAll): not a source.
    const sib0 = path.join(workspace, 'sib-0');
    addWorktree(main, sib0, 'sib-0', base);
    CodeGraph.initSync(sib0).close();

    await indexDir(sibB);
    await indexDir(sib3);
    await indexDir(sibA);
    // `main` (distance 0) has no index at all: not a source either.

    expect(await pickSeedSource(target)).toBe(real(sibA));
  }, 30_000);

  it('pickSeedSource answers null when no sibling has a complete index', async () => {
    const target = path.join(workspace, 'wt-target');
    addWorktree(main, target, 'target');
    expect(await pickSeedSource(target)).toBeNull();
  });
});

describe('worktree seeding: what a seed copies (G1, G4, G6)', () => {
  let workspace: string;
  let main: string;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-seed-copy-')));
    main = path.join(workspace, 'main');
    makeRepo(main);
    await indexDir(main);
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
      }
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('G1: two worktrees at the same HEAD seeded from one sibling hold identical rows', async () => {
    const wt1 = path.join(workspace, 'wt-1');
    const wt2 = path.join(workspace, 'wt-2');
    addWorktree(main, wt1, 'one');
    addWorktree(main, wt2, 'two');

    // The builder's host: the copies run as jobs on a queue, as they do in the builder process.
    const host = new BuilderSeedHost(new JobQueue());
    const first = await ensureWorktreeIndex(wt1, host);
    const second = await ensureWorktreeIndex(wt2, host);
    expect(first).toMatchObject({ kind: 'seeded', root: real(wt1), source: real(main) });
    expect(second).toMatchObject({ kind: 'seeded', root: real(wt2), source: real(main) });

    const dump1 = logicalDump(wt1);
    expect(JSON.parse(dump1).nodes.length).toBeGreaterThan(0);
    expect(logicalDump(wt2)).toBe(dump1);
  });

  it('G4: the target gets codegraph.db, an empty codegraph.db-wal and .gitignore, and no lock or pid file', async () => {
    const src = path.join(main, '.codegraph');
    // A pid no process holds, so the seeder's own lock on the source is free.
    const deadPid = '999999';
    fs.writeFileSync(path.join(src, 'writer.pid'), `${deadPid}\n`);
    fs.writeFileSync(path.join(src, 'codegraph.lock'), `${deadPid}\n`);
    fs.writeFileSync(path.join(src, 'daemon.pid'), `${deadPid}\n`);
    const target = path.join(workspace, 'wt-copy');
    addWorktree(main, target, 'copy');

    const { method, nonce } = await seedFromSibling(real(target), real(main));
    expect(['clone', 'copy', 'backup']).toContain(method);
    // R1: on macOS a free source is cloned (APFS clonefile through `cp -c`).
    if (process.platform === 'darwin') expect(method).toBe('clone');

    const dir = path.join(target, '.codegraph');
    // Writing the seed nonce into the staged copy leaves no side file of it.
    expect(fs.readdirSync(dir).sort()).toEqual(['.gitignore', 'codegraph.db', 'codegraph.db-wal']);
    // The installed database carries the nonce the seed returned; the source does not.
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(readSeedNonce(real(target))).toBe(nonce);
    expect(readSeedNonce(real(main))).toBeNull();
    expect(fs.statSync(path.join(dir, 'codegraph.db-wal')).size).toBe(0);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(fs.readFileSync(path.join(src, '.gitignore'), 'utf8'));
    const db = new DatabaseSync(path.join(dir, 'codegraph.db'), { readOnly: true });
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n).toBe(3);
    } finally {
      db.close();
    }
  });

  // G6. A writer child process commits to the source's database in a tight
  // loop while the source is seeded five times. Each seed must be a sound
  // database, whichever path (clone under the fence, or backup) it took.
  // Five tiny seeds plus a node child start: about 2 s on an idle machine. Five seeds against a busy writer child
  // can pass 5 s under load, so the test has an explicit 20 s timeout rather than the 5 s default.
  it('G6: seeds taken while a writer commits to the source all pass integrity_check', async () => {
    const writerScript = [
      "const { DatabaseSync } = require('node:sqlite');",
      'const db = new DatabaseSync(process.argv[1]);',
      "db.exec('PRAGMA busy_timeout = 5000');",
      "db.exec('CREATE TABLE IF NOT EXISTS g6_writer (id INTEGER PRIMARY KEY, payload TEXT)');",
      "const ins = db.prepare('INSERT INTO g6_writer (payload) VALUES (?)');",
      'let i = 0; let announced = false;',
      'const tick = () => {',
      "  db.exec('BEGIN IMMEDIATE');",
      "  for (let k = 0; k < 50; k++) ins.run('x'.repeat(256) + (i++));",
      "  db.exec('COMMIT');",
      "  if (!announced) { announced = true; process.stdout.write('ready\\n'); }",
      '  setImmediate(tick);',
      '};',
      'tick();',
    ].join('\n');
    const writer = spawn(process.execPath, ['--no-warnings', '-e', writerScript, dbPath(main)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(writer);
    await new Promise<void>((resolve, reject) => {
      writer.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString().includes('ready')) resolve(); });
      writer.once('exit', (code) => reject(new Error(`writer exited early (${code})`)));
    });

    const targets: string[] = [];
    for (let n = 0; n < 5; n++) {
      const target = path.join(workspace, `wt-fence-${n}`);
      addWorktree(main, target, `fence-${n}`);
      const { method } = await seedFromSibling(real(target), real(main));
      expect(['clone', 'copy', 'backup']).toContain(method);
      targets.push(target);
    }
    expect(writer.exitCode).toBeNull(); // the writer ran for the whole run

    for (const target of targets) {
      const db = new DatabaseSync(dbPath(target), { readOnly: true });
      try {
        expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
        expect((db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n).toBe(3);
      } finally {
        db.close();
      }
    }
  }, 20_000);
});
