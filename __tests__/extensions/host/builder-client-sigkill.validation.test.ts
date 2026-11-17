/**
 * The SIGKILL replacement case of builder-client.integration.test.ts: a killed builder is replaced, its dead
 * locks are reclaimed, and the roots it held and the build it was running are taken up again by the new one.
 * It is in the validation group because its outcome is timing-sensitive under load (ruling S-67).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { isInitialized } from '../../../src/directory';
import { BuilderClient } from '../../../src/extensions/host/builder/client';
import { readWriterLock } from '../../../src/mcp/writer-lock';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function real(p: string): string {
  return fs.realpathSync(path.resolve(p));
}

function makeRepo(dir: string, body = 'export function baseSymbol() { return 1; }\n'): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'src', 'base.ts'), body);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

async function indexDir(dir: string): Promise<void> {
  const cg = await CodeGraph.init(dir);
  try { await cg.indexAll(); } finally { cg.close(); }
}

async function waitUntil(check: () => boolean, timeoutMs: number, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return check();
}

function builderLog(stateDir: string): string[] {
  try {
    return fs.readFileSync(path.join(stateDir, 'builder.log'), 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
}

function pidFilePid(stateDir: string): number | null {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(stateDir, 'builder.pid'), 'utf8')) as { pid?: unknown };
    return typeof record.pid === 'number' ? record.pid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Engine startup, builds and replacement processes can each take minutes at host load 175; wait on events.
describe('the index builder process, through BuilderClient', { timeout: 600_000 }, () => {
  let workspace: string;
  let stateDir: string;
  let client: BuilderClient | undefined;

  beforeEach(() => {
    // Plain-directory cases must be outside git and indexed ancestors; the harness's POSIX TMPDIR can be in a checkout.
    workspace = real(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cg-builder-client-')));
    stateDir = path.join(workspace, 'state');
    // The builder is forked with this environment.
    vi.stubEnv('CODEGRAPH_STATE_DIR', stateDir);
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    vi.stubEnv('CODEGRAPH_WATCH_DEBOUNCE_MS', '100');
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '');
  });

  afterEach(async () => {
    await client?.stop();
    client = undefined;
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 180_000);

  // About 10 s on an overloaded machine, by design: two builder processes (the killed one and its replacement)
  // each load the whole engine, and the replacement runs a 4 s held cold build (the delay knob) to its end.
  // slow: forks a real builder that loads the engine; indexing and IPC wait for host CPU under heavy load.
  it('after SIGKILL the client starts a new builder, whose own pid reclaims the dead one\'s locks and takes the roots up again', async () => {
    const held = path.join(workspace, 'held');
    makeRepo(held);
    await indexDir(held);
    const main = path.join(workspace, 'main');
    makeRepo(main);
    const wt = path.join(workspace, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
    vi.stubEnv('CODEGRAPH_BUILDER_COLD_BUILD_DELAY_MS', '4000');
    client = BuilderClient.start();
    expect(await waitUntil(() => client?.isUp() === true, 120_000)).toBe(true);

    expect(await client.ensure(held)).toMatchObject({ kind: 'ready' });
    expect((await client.ensure(wt)).kind).toBe('building');
    const killed = client.pid()!;
    expect(await waitUntil(() => readWriterLock(wt, 'rebuild.pid')?.pid === killed, 120_000)).toBe(true);
    expect(readWriterLock(held)?.pid).toBe(killed);

    process.kill(killed, 'SIGKILL');
    expect(await waitUntil(() => !alive(killed), 120_000)).toBe(true);
    // The builder is replaced, and says so in builder.pid.
    expect(await waitUntil(() => client!.pid() !== null && client!.pid() !== killed, 120_000)).toBe(true);
    expect(await waitUntil(() => client?.isUp() === true, 120_000)).toBe(true);
    const replacement = client.pid()!;
    expect(await waitUntil(() => pidFilePid(stateDir) === replacement, 120_000)).toBe(true);

    // The held root is held again, by the new pid (the dead pid's writer.pid was reclaimed).
    expect(await waitUntil(() => readWriterLock(held)?.pid === replacement, 120_000)).toBe(true);
    // The killed cold build is built again, with no further call: the client queued it for the new builder.
    expect(await waitUntil(() => isInitialized(wt) && readWriterLock(wt, 'rebuild.pid') === null, 180_000)).toBe(true);
    expect(builderLog(stateDir).some((l) => / job end cold-build \S+ ok$/.test(l))).toBe(true);
    expect(client.pid()).toBe(replacement);
  });
});
