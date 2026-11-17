import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { isProcessAlive } from '../../../src/mcp/server-control';
import { readWriterLock } from '../../../src/mcp/writer-lock';
import { discardSchemalessLeftover } from '../../../src/extensions/host/worktree-lifecycle/discardSchemalessLeftover';

const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
let root: string;
let dbPath: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cg-discard-schemaless-')));
  fs.mkdirSync(path.join(root, '.codegraph'));
  dbPath = path.join(root, '.codegraph', 'codegraph.db');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function createSchemaOnlyDb(): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(fs.readFileSync(path.join(process.cwd(), 'src/db/schema.sql'), 'utf8').split('\n').slice(0, 13).join('\n'));
  } finally {
    db.close();
  }
}

describe('discardSchemalessLeftover', () => {
  it('removes a schema-only database and its SQLite siblings', () => {
    createSchemaOnlyDb();
    const files = ['', '-wal', '-shm', '-journal'].map((suffix) => dbPath + suffix);
    for (const file of files.slice(1)) fs.writeFileSync(file, '');
    expect(discardSchemalessLeftover(root)).toBe(true);
    for (const file of files) expect(fs.existsSync(file)).toBe(false);
  });

  it('removes an empty database file', () => {
    fs.writeFileSync(dbPath, '');
    expect(discardSchemalessLeftover(root)).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('keeps a database with the full schema', () => {
    CodeGraph.initSync(root).close();
    const inode = fs.statSync(dbPath).ino;
    expect(discardSchemalessLeftover(root)).toBe(false);
    expect(fs.statSync(dbPath).ino).toBe(inode);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get()).toEqual({ name: 'nodes' });
    } finally {
      db.close();
    }
  });

  it('returns false when there is no database', () => {
    expect(discardSchemalessLeftover(root)).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('keeps a non-SQLite file unchanged', () => {
    fs.writeFileSync(dbPath, 'this is not a SQLite database');
    expect(discardSchemalessLeftover(root)).toBe(false);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('this is not a SQLite database');
  });

  it('keeps a schema-only database when another live process holds writer.pid', () => {
    createSchemaOnlyDb();
    expect(process.ppid).not.toBe(process.pid);
    expect(isProcessAlive(process.ppid)).toBe(true);
    fs.writeFileSync(path.join(root, '.codegraph', 'writer.pid'), JSON.stringify({ pid: process.ppid, mode: 'builder', startedAt: Date.now(), root }) + '\n');
    expect(readWriterLock(root)?.pid).toBe(process.ppid);
    const inode = fs.statSync(dbPath).ino;
    expect(discardSchemalessLeftover(root)).toBe(false);
    expect(fs.statSync(dbPath).ino).toBe(inode);
  });
});
