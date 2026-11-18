/**
 * The query worker's read-only open, through the built worker (dist/mcp/query-worker.js): an index with an
 * unfinished repair is not healed by a worker (a writable open rewrites the database; a read-only one leaves
 * it). The other server-side cases are in index-builder.server.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import CodeGraph from '../../../src/index';

const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
const textOf = (res: { content: Array<{ type: string; text?: string }> }): string =>
  res.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('\n');

describe('the server side of the index builder', { timeout: 60_000 }, () => {
  let workspace: string;
  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cg-ibserver-')));
  });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  async function indexedProject(): Promise<string> {
    const root = path.join(workspace, 'proj');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function alphaSymbol() { return "alpha-body-marker"; }\n');
    const cg = await CodeGraph.init(root);
    try { await cg.indexAll(); } finally { cg.close(); }
    return root;
  }

  // ---- the query worker ----

  it('a query worker opens every project read-only: an index with an unfinished repair is left as it is', async () => {
    const root = await indexedProject();
    // A bulk load the last writer never finished: the FTS trigger is missing. A WRITABLE open heals it by
    // rewriting the database; a read-only open leaves that to the writer.
    const dbFile = path.join(root, '.codegraph', 'codegraph.db');
    const db = new DatabaseSync(dbFile);
    db.exec('DROP TRIGGER IF EXISTS nodes_au');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const digest = (): string => {
      const ro = new DatabaseSync(dbFile, { readOnly: true });
      try {
        const objects = ro.prepare('SELECT type, name FROM sqlite_master ORDER BY type, name').all();
        return createHash('sha256').update(JSON.stringify(objects)).update(fs.readFileSync(dbFile)).digest('hex');
      } finally {
        ro.close();
      }
    };
    const before = digest();

    const worker = new Worker(path.resolve(__dirname, '../../../dist/mcp/query-worker.js'), { workerData: { root: null } });
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once('error', reject);
        worker.on('message', (m: { type?: string; ok?: boolean; error?: string }) => {
          if (m?.type === 'ready') m.ok ? resolve() : reject(new Error(String(m.error)));
        });
      });
      const result = await new Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>((resolve, reject) => {
        worker.once('error', reject);
        worker.on('message', (m: { type?: string; result?: never }) => { if (m?.type === 'result') resolve(m.result!); });
        worker.postMessage({ type: 'call', id: 1, toolName: 'codegraph_search', args: { query: 'alphaSymbol', projectPath: root } });
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('alphaSymbol');
      expect(digest(), 'the worker opened the index read-only: no repair, no migration, no write').toBe(before);
    } finally {
      await worker.terminate();
    }
  });
});
