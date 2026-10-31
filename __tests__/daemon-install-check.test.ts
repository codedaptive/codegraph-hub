/**
 * A machine server whose install was upgraded or deleted underneath it exits
 * (#2335).
 *
 * The server loads grammars (and the native kernel, and worker scripts) lazily
 * from the directory it was started from. An upgrade replaces or deletes that
 * directory while the server keeps running, so every later load fails; the
 * 1.6.1 daemon in #2335 went on re-indexing files as empty for as long as it
 * lived. The server checks its own package.json periodically and makes way for
 * a server started from the current install. The check is pure and the Daemon's
 * reaction is tested with it injected; neither starts a real server.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Daemon, installChangedReason } from '../src/mcp/daemon';

describe('installChangedReason', () => {
  let dir: string;
  let pkg: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-install-check-'));
    pkg = path.join(dir, 'package.json');
    fs.writeFileSync(pkg, JSON.stringify({ name: '@colbymchenry/codegraph', version: '1.6.2' }));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is null while the install still carries the running version', () => {
    expect(installChangedReason(pkg, '1.6.2')).toBeNull();
  });

  it('reports an install upgraded in place', () => {
    fs.writeFileSync(pkg, JSON.stringify({ version: '1.6.3' }));
    expect(installChangedReason(pkg, '1.6.2')).toMatch(/replaced by v1\.6\.3/);
  });

  it('reports an install that was deleted, file or whole directory', () => {
    fs.rmSync(pkg);
    expect(installChangedReason(pkg, '1.6.2')).toMatch(/removed/);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(installChangedReason(pkg, '1.6.2')).toMatch(/removed/);
  });

  it('waits for a package.json caught mid-write instead of exiting on it', () => {
    fs.writeFileSync(pkg, '{"name": "@colbymchenry/codeg');
    expect(installChangedReason(pkg, '1.6.2')).toBeNull();
    fs.writeFileSync(pkg, '');
    expect(installChangedReason(pkg, '1.6.2')).toBeNull();
  });
});

describe('Daemon.checkInstall', () => {
  // A Daemon is safe to construct: nothing binds until start(), and it only
  // reads its socket and lock paths from the state dir, pointed at a throwaway
  // one here. Its engine would start a query pool, so the pool is turned off and
  // the engine stopped after each case. stop() is replaced so a positive check
  // can't tear down the test process.
  let stateDir: string;
  const savedEnv = { state: process.env.CODEGRAPH_STATE_DIR, pool: process.env.CODEGRAPH_QUERY_POOL_SIZE };
  const made: any[] = [];

  beforeEach(() => {
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-install-check-state-')));
    process.env.CODEGRAPH_STATE_DIR = stateDir;
    process.env.CODEGRAPH_QUERY_POOL_SIZE = '0';
  });

  afterEach(async () => {
    for (const d of made.splice(0)) await d.engine.stop();
    for (const [key, value] of [['CODEGRAPH_STATE_DIR', savedEnv.state], ['CODEGRAPH_QUERY_POOL_SIZE', savedEnv.pool]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const makeDaemon = () => {
    const d = new Daemon() as any;
    made.push(d);
    d.stop = vi.fn(async () => {});
    return d;
  };

  it('stops the daemon when its install changed', () => {
    const d = makeDaemon();
    expect(d.checkInstall(() => 'Install removed')).toBe(true);
    expect(d.stop).toHaveBeenCalledWith('install changed');
  });

  it('keeps running while the install is unchanged', () => {
    const d = makeDaemon();
    expect(d.checkInstall(() => null)).toBe(false);
    expect(d.stop).not.toHaveBeenCalled();
  });

  it('does nothing once the daemon is already stopping', () => {
    const d = makeDaemon();
    d.stopping = true;
    expect(d.checkInstall(() => 'Install removed')).toBe(false);
    expect(d.stop).not.toHaveBeenCalled();
  });
});
