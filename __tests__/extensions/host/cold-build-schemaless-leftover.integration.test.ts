import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { isProcessAlive } from '../../../src/mcp/server-control';
import { runColdBuild } from '../../../src/extensions/host/worktree-lifecycle/cold-build';

const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
const deadPid = 999999;
let workspace: string;
let root: string;
let dbPath: string;

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cg-cold-schemaless-')));
  vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
  root = path.join(workspace, 'repo');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'src', 'alpha.ts'), 'export function alphaSymbol() {}\n');
  execFileSync('git', ['add', 'src/alpha.ts'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], { cwd: root });
  fs.mkdirSync(path.join(root, '.codegraph'));
  dbPath = path.join(root, '.codegraph', 'codegraph.db');
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

describe('cold build with a schema-only database', () => {
  it('rebuilds an interrupted cold build after reclaiming its dead holder', async () => {
    expect(isProcessAlive(deadPid)).toBe(false);
    const lockPath = path.join(root, '.codegraph', 'rebuild.pid');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, mode: 'cold-build', startedAt: Date.now(), root: fs.realpathSync(root) }) + '\n');

    expect(await runColdBuild(root)).toBe(0);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get()).toEqual({ name: 'nodes' });
      expect(db.prepare("SELECT value FROM project_metadata WHERE key = 'index_state'").get()).toEqual({ value: 'complete' });
    } finally {
      db.close();
    }
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('preserves a schema-only database without a rebuild lock', async () => {
    const inode = fs.statSync(dbPath).ino;
    expect(await runColdBuild(root)).toBe(1);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.statSync(dbPath).ino).toBe(inode);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare('SELECT version FROM schema_versions').all()).toEqual([{ version: 1 }]);
    } finally {
      db.close();
    }
  });
});
