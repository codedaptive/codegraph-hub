import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { isProcessAlive } from '../../../src/mcp/server-control';
import { ensureWorktreeIndex, seedWorktreeNow } from '../../../src/extensions/host/worktree-lifecycle/seed';
import { BuilderSeedHost } from '../../../src/extensions/host/builder/seed-host';
import { JobQueue } from '../../../src/extensions/host/builder/queue';

const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('worktree seeding with a schema-only database', () => {
  let workspace: string;
  let main: string;
  let wt: string;
  let dbPath: string;

  beforeEach(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync('/tmp/cg-seed-schemaless-'));
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    main = path.join(workspace, 'main');
    wt = path.join(workspace, 'wt');
    fs.mkdirSync(path.join(main, 'src'), { recursive: true });
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'config', 'user.email', 'test@example.com');
    git(main, 'config', 'user.name', 'Test');
    git(main, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(main, 'src', 'alpha.ts'), 'export function alphaSymbol() { return 2; }\n');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    const cg = await CodeGraph.init(main);
    await cg.indexAll();
    cg.close();
    git(main, 'worktree', 'add', '-q', '-b', 'linked', wt);
    fs.mkdirSync(path.join(wt, '.codegraph'));
    dbPath = path.join(wt, '.codegraph', 'codegraph.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(fs.readFileSync(path.join(process.cwd(), 'src/db/schema.sql'), 'utf8').split('\n').slice(0, 13).join('\n'));
    } finally {
      db.close();
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('replaces an abandoned schema-only database with the sibling index', async () => {
    expect(isProcessAlive(999999)).toBe(false);
    fs.writeFileSync(path.join(wt, '.codegraph', 'rebuild.pid'), JSON.stringify({
      pid: 999999, mode: 'cold-build', startedAt: Date.now(), root: fs.realpathSync(wt),
    }) + '\n');

    const outcome = await ensureWorktreeIndex(wt, new BuilderSeedHost(new JobQueue()));
    expect(outcome).toMatchObject({ kind: 'seeded', root: fs.realpathSync(wt), source: fs.realpathSync(main) });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get()).toEqual({ name: 'nodes' });
      expect(db.prepare('SELECT * FROM nodes').all().length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('explicitly seeds over an abandoned schema-only database', async () => {
    expect(isProcessAlive(999999)).toBe(false);
    fs.writeFileSync(path.join(wt, '.codegraph', 'rebuild.pid'), JSON.stringify({
      pid: 999999, mode: 'cold-build', startedAt: Date.now(), root: fs.realpathSync(wt),
    }) + '\n');

    const outcome = await seedWorktreeNow(wt);
    expect(outcome).toMatchObject({ kind: 'seeded', root: fs.realpathSync(wt), source: fs.realpathSync(main) });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get()).toEqual({ name: 'nodes' });
      expect(db.prepare('SELECT * FROM nodes').all().length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('preserves a schema-only database without a rebuild lock', async () => {
    const inode = fs.statSync(dbPath).ino;
    const outcome = await ensureWorktreeIndex(wt, new BuilderSeedHost(new JobQueue()));
    expect(outcome.kind).not.toBe('seeded');
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.statSync(dbPath).ino).toBe(inode);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare('SELECT version FROM schema_versions').all()).toEqual([{ version: 1 }]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
