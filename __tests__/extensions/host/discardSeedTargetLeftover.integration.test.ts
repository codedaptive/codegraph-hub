import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isProcessAlive } from '../../../src/mcp/server-control';
import { discardSeedTargetLeftover } from '../../../src/extensions/host/worktree-lifecycle/discardSeedTargetLeftover';

const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
let workspace: string;
let root: string;
let dbPath: string;
let rebuildPath: string;

function writeLock(file: string, pid: number, mode: string): string {
  const record = JSON.stringify({ pid, mode, startedAt: Date.now(), root }) + '\n';
  fs.writeFileSync(file, record);
  return record;
}

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync('/tmp/cg-seed-target-'));
  vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
  root = path.join(workspace, 'repo');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  fs.mkdirSync(path.join(root, '.codegraph'));
  dbPath = path.join(root, '.codegraph', 'codegraph.db');
  rebuildPath = path.join(root, '.codegraph', 'rebuild.pid');
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

describe('discardSeedTargetLeftover', () => {
  it('preserves the database and dead lock while a rebuild is held', () => {
    expect(isProcessAlive(999999)).toBe(false);
    const record = writeLock(rebuildPath, 999999, 'cold-build');
    const inode = fs.statSync(dbPath).ino;
    expect(discardSeedTargetLeftover(root, () => true)).toBe(false);
    expect(fs.statSync(dbPath).ino).toBe(inode);
    expect(fs.readFileSync(rebuildPath, 'utf8')).toBe(record);
  });

  it('preserves the database when there is no rebuild lock', () => {
    const inode = fs.statSync(dbPath).ino;
    expect(discardSeedTargetLeftover(root, () => false)).toBe(false);
    expect(fs.statSync(dbPath).ino).toBe(inode);
    expect(fs.existsSync(rebuildPath)).toBe(false);
  });

  it.each(['parent', 'self'])('preserves the database and rebuild lock held by %s', (holder) => {
    const pid = holder === 'parent' ? process.ppid : process.pid;
    expect(isProcessAlive(pid)).toBe(true);
    if (holder === 'parent') expect(pid).not.toBe(process.pid);
    const record = writeLock(rebuildPath, pid, 'cold-build');
    const inode = fs.statSync(dbPath).ino;
    expect(discardSeedTargetLeftover(root, () => false)).toBe(false);
    expect(fs.statSync(dbPath).ino).toBe(inode);
    expect(fs.readFileSync(rebuildPath, 'utf8')).toBe(record);
  });

  it('discards a schema-only database after taking over a dead rebuild lock', () => {
    expect(isProcessAlive(999999)).toBe(false);
    writeLock(rebuildPath, 999999, 'cold-build');
    expect(discardSeedTargetLeftover(root, () => false)).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(rebuildPath)).toBe(false);
  });

  it('preserves the database when a live writer holds it', () => {
    expect(isProcessAlive(999999)).toBe(false);
    expect(isProcessAlive(process.ppid)).toBe(true);
    expect(process.ppid).not.toBe(process.pid);
    writeLock(rebuildPath, 999999, 'cold-build');
    writeLock(path.join(root, '.codegraph', 'writer.pid'), process.ppid, 'builder');
    const inode = fs.statSync(dbPath).ino;
    expect(discardSeedTargetLeftover(root, () => false)).toBe(false);
    expect(fs.statSync(dbPath).ino).toBe(inode);
  });

  it('returns false when a dead rebuild holder left no database', () => {
    expect(isProcessAlive(999999)).toBe(false);
    writeLock(rebuildPath, 999999, 'cold-build');
    fs.unlinkSync(dbPath);
    expect(discardSeedTargetLeftover(root, () => false)).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});
