import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

describe('codegraph unlock: indexing lock recovery', () => {
  let tempDir: string;
  let stateDir: string;

  /** Every run gets its own state dir, so nothing here can reach the live server of `~/.codegraph`. */
  function runCodegraph(args: string[]): string {
    return execFileSync(process.execPath, [BIN, ...args], {
      cwd: tempDir,
      encoding: 'utf8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_STATE_DIR: stateDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-unlock-'));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-unlock-state-'));
    const cg = CodeGraph.initSync(tempDir);
    cg.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('removes the stale indexing lock, then permits indexing', () => {
    const lockPath = path.join(tempDir, '.codegraph', 'codegraph.lock');
    fs.writeFileSync(lockPath, 'stale\n');

    const output = runCodegraph(['unlock', tempDir]);

    expect(output).toContain('Removed stale lock artifacts');
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(() => runCodegraph(['index', '--quiet', tempDir])).not.toThrow();
  });

  it('never touches the machine server\'s lock or socket', () => {
    // The server belongs to the whole machine, not to one project: unlock
    // clears the project's indexing lock and leaves the server's files alone,
    // whatever they hold. (`codegraph daemon --stop` is how a server is stopped.)
    const pidPath = path.join(stateDir, 'server.pid');
    const socketPath = path.join(stateDir, 'server.sock');
    fs.writeFileSync(path.join(tempDir, '.codegraph', 'codegraph.lock'), 'stale\n');
    fs.writeFileSync(pidPath, 'not-a-lock\n');
    fs.writeFileSync(socketPath, 'stale\n');

    const output = runCodegraph(['unlock', tempDir]);

    expect(output).toContain('Removed stale lock artifacts');
    expect(fs.readFileSync(pidPath, 'utf8')).toBe('not-a-lock\n');
    expect(fs.readFileSync(socketPath, 'utf8')).toBe('stale\n');
  });

  it('reports nothing to do when no indexing lock exists', () => {
    const output = runCodegraph(['unlock', tempDir]);

    expect(output).toContain('No stale lock files found');
  });
});
