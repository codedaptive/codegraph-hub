/**
 * Race and robustness validation of the worktree lifecycle, against the built
 * code in dist/ (the index builder `BuilderClient.start` runs, and the built
 * registry). Each case asserts what is left on disk or in the registry, not
 * names or return values.
 *
 * - Seed (`ensureWorktreeIndex` through the engine's tool handler and the
 *   index builder): a seed that fails while a sibling qualifies (the target's
 *   `codegraph.lock` held past the retries) never queues a cold build, though
 *   cold builds need no opt-in: the call answers the success-shaped
 *   not-indexed guidance, and the next call tries the seed again.
 * - Registry: pin, unpin and seed registration from concurrent processes on
 *   one root never lose a bit or a nonce.
 *
 * Real git repositories, real SQLite and real child processes in mkdtemp dirs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { MCPEngine } from '../../../src/mcp/engine';
import { __setLoadCodeGraphForTests } from '../../../src/mcp/tools';
import { ADMIT_ALL } from '../../helpers/admit-all';
import {
  PROJECT_FLAG_PINNED,
  getRegisteredProject,
  readSeedNonce,
} from '../../../src/extensions/host/worktree-lifecycle/project-registry';
import { BuilderClient } from '../../../src/extensions/host/builder/client';
import { clearRegistry } from './helpers/clear-registry';
import { dbFile } from './helpers/db-file';
import { FIXTURE_TMP } from './helpers/fixture-tmp';
import { real } from './helpers/real';
import { repoWithWorktree } from './helpers/repo-with-worktree';

const DIST = path.resolve(__dirname, '../../../dist');

// ---------------------------------------------------------------------------
// Seed: a failed seed with a qualifying sibling never cold-builds
// ---------------------------------------------------------------------------

// Builds an index and serves two calls through a real engine and a real index
// builder process; the bound only catches a hang on a loaded machine.
describe('a seed that fails while a sibling qualifies never queues a cold build', { timeout: 600_000, hookTimeout: 180_000 }, () => {
  let workspace: string;
  let wt: string;
  let stateDir: string;
  let engine: MCPEngine | undefined;
  let builder: BuilderClient | undefined;

  beforeEach(async () => {
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '');
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    vi.stubEnv('CODEGRAPH_WATCH_DEBOUNCE_MS', '100');
    vi.stubEnv('CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS', '0');
    vi.stubEnv('CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS', '0');
    // Stay below the client's 120 s RPC backstop while allowing the seed to finish under load.
    vi.stubEnv('CODEGRAPH_BUILDER_ENSURE_WAIT_MS', '90000');
    workspace = real(fs.mkdtempSync(path.join(FIXTURE_TMP, 'cg-race-f1-')));
    // The builder's own state dir, so its job log (builder.log) is this case's alone.
    stateDir = path.join(workspace, 'state');
    vi.stubEnv('CODEGRAPH_STATE_DIR', stateDir);
    ({ wt } = await repoWithWorktree(workspace));
    // The target's codegraph.lock, held by a live process (this one) for the
    // whole first call: every attempt of the seed to install fails.
    fs.mkdirSync(path.join(wt, '.codegraph'));
    fs.writeFileSync(path.join(wt, '.codegraph', 'codegraph.lock'), String(process.pid));
    __setLoadCodeGraphForTests(CodeGraph);
    builder = BuilderClient.start();
    engine = new MCPEngine({ builder });
  }, 180_000);

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
    await builder?.stop();
    builder = undefined;
    __setLoadCodeGraphForTests(null);
    vi.unstubAllEnvs();
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 180_000);

  async function search(): Promise<{ text: string; isError: boolean }> {
    const res = await engine!.getToolHandler().execute('codegraph_search', { query: 'appSymbol', projectPath: wt }, undefined, ADMIT_ALL);
    return { text: res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'), isError: Boolean(res.isError) };
  }

  // slow: a real builder must finish a failed seed and retry it after the held target lock is released.
  it('answers the not-indexed guidance, starts no build, and seeds on the next call', async () => {
    const first = await search();
    expect(first.isError).toBe(false);
    expect(first.text).not.toContain('is building the index');
    expect(first.text).toContain("isn't indexed with codegraph yet");
    // A cold build takes rebuild.pid first thing; none may appear, and the
    // builder's job log shows the seed attempt and no cold-build job.
    await vi.waitFor(() => {
      expect(fs.readFileSync(path.join(stateDir, 'builder.log'), 'utf8')).toMatch(/job end seed \S+ failed/);
    }, { timeout: 180_000 });
    const jobLog = fs.readFileSync(path.join(stateDir, 'builder.log'), 'utf8');
    expect(jobLog).toMatch(/job end seed \S+ failed/);
    expect(jobLog).not.toContain('cold-build');
    expect(fs.existsSync(path.join(wt, '.codegraph', 'rebuild.pid'))).toBe(false);
    expect(fs.existsSync(dbFile(wt))).toBe(false);
    // The holder's lock is untouched.
    expect(fs.readFileSync(path.join(wt, '.codegraph', 'codegraph.lock'), 'utf8')).toBe(String(process.pid));

    // The holder lets go: the next call copies the sibling's index in.
    fs.unlinkSync(path.join(wt, '.codegraph', 'codegraph.lock'));
    const second = await search();
    expect(second.isError).toBe(false);
    expect(second.text).toContain('appSymbol');
    expect(getRegisteredProject(wt)?.seedNonce).toBe(readSeedNonce(wt));
  });
});

// ---------------------------------------------------------------------------
// Registry: concurrent registry updates lose nothing
// ---------------------------------------------------------------------------

/**
 * One registry client in its own process, against the built registry. Waits
 * for `<barrier>/go`, then runs its role `n` times, reading its own write back
 * each time: `seeder` registers seed nonce `nonce-<i>` and expects to read it;
 * `pinner` pins and expects pinned, then unpins and expects unpinned (ending
 * pinned); `other` re-registers the root with a common dir. Prints the number
 * of read-backs that did not hold.
 */
const REGISTRY_CLIENT = `
const fs = require('fs');
const path = require('path');
const [registryModule, root, role, n, barrier] = process.argv.slice(2);
const R = require(registryModule);
fs.writeFileSync(path.join(barrier, 'ready-' + role), '');
const tick = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(path.join(barrier, 'go'))) Atomics.wait(tick, 0, 0, 1);
let violations = 0;
for (let i = 0; i < Number(n); i++) {
  if (role === 'seeder') {
    R.registerProject(root, { seeded: true, seedNonce: 'nonce-' + i });
    if (R.getRegisteredProject(root)?.seedNonce !== 'nonce-' + i) violations++;
  } else if (role === 'pinner') {
    R.pinProject(root);
    if (!R.isPinned(root)) violations++;
    if (i < Number(n) - 1) {
      R.unpinProject(root);
      if (R.isPinned(root)) violations++;
    }
  } else {
    R.registerProject(root, { commonDir: '/some/common/dir' });
  }
}
process.stdout.write(JSON.stringify({ violations }));
`;

// Spawns three node processes against the built registry; the bound only
// catches a hang on a loaded machine.
describe('concurrent pins and seed registrations of one root lose no bit and no nonce', { timeout: 600_000, hookTimeout: 180_000 }, () => {
  let workspace: string;

  beforeEach(() => {
    workspace = real(fs.mkdtempSync(path.join(FIXTURE_TMP, 'cg-race-f6-')));
  });

  afterEach(() => {
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  // Three real node processes contend on one record through the built registry.
  // slow: three node processes perform 150 contending updates each through the built registry.
  it('three processes updating one record: every read-back holds, and the record ends pinned with the last nonce', async () => {
    const root = path.join(workspace, 'project');
    fs.mkdirSync(root);
    const script = path.join(workspace, 'registry-client.js');
    fs.writeFileSync(script, REGISTRY_CLIENT);
    const barrier = path.join(workspace, 'barrier');
    fs.mkdirSync(barrier);
    const registryModule = path.join(DIST, 'extensions', 'host', 'worktree-lifecycle', 'project-registry.js');
    // Enough rounds per process that three of them overlap inside the record
    // lock many times; the finite count bounds the stress workload.
    const n = 150;
    const roles = ['seeder', 'pinner', 'other'];
    const runs = roles.map((role) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [script, registryModule, root, role, String(n), barrier], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      child.stdout!.on('data', (d) => { out += d; });
      child.stderr!.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ code, out, err }));
    }));
    await vi.waitFor(() => {
      for (const role of roles) expect(fs.existsSync(path.join(barrier, `ready-${role}`))).toBe(true);
    }, { timeout: 180_000 });
    fs.writeFileSync(path.join(barrier, 'go'), '');
    const results = await Promise.all(runs);
    for (const r of results) expect(r.code, r.err).toBe(0);
    const violations = results.reduce((sum, r) => sum + (JSON.parse(r.out) as { violations: number }).violations, 0);
    expect(violations).toBe(0);
    const rec = getRegisteredProject(root);
    expect((rec!.flags & PROJECT_FLAG_PINNED) !== 0).toBe(true);
    expect(rec!.seedNonce).toBe(`nonce-${n - 1}`);
  });
});
