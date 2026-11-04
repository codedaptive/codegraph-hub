/**
 * Project registry.
 *
 * src/extensions/host/worktree-lifecycle/project-registry.ts keeps one JSON record per project root under
 * <state dir>/projects: ~/.codegraph (os.homedir(), so the home sandbox of
 * __tests__/setup-home-sandbox.ts isolates it) unless CODEGRAPH_STATE_DIR names another. A record carries the canonical
 * root, the git common dir recorded at registration, a flags bitmap
 * (bit 0 pinned, bit 1 seeded), an ISO8601 registeredAt and, for a seeded
 * root, the seed nonce its index carries. Registering is idempotent and never
 * clears a set bit; a given nonce replaces the recorded one, none keeps it.
 *
 * The module is imported per test (dynamic import) so that, before it exists,
 * every test fails on the missing module rather than the file failing once.
 *
 * A change to a record waits for its record lock on a time budget (about
 * 2 s), not a count of attempts: a lock held by a live process that keeps
 * reading as released (the immediate retry a release earns) does not use the
 * wait up before the holder lets go.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A writable copy of the fs namespace, shared by this file and every src
// module it loads, so vi.spyOn(fs, 'existsSync') reaches the registry (the
// ESM namespace of the builtin cannot be redefined).
vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>() }));

type Registry = typeof import('../../../src/extensions/host/worktree-lifecycle/project-registry');
const loadRegistry = (): Promise<Registry> => import('../../../src/extensions/host/worktree-lifecycle/project-registry');

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

describe('project registry (G9)', () => {
  let tempDir: string;
  let alpha: string;
  let beta: string;
  let savedStateDir: string | undefined;

  beforeEach(() => {
    // The default state dir is what most tests here measure: a developer's own
    // CODEGRAPH_STATE_DIR must not move it.
    savedStateDir = process.env.CODEGRAPH_STATE_DIR;
    delete process.env.CODEGRAPH_STATE_DIR;
    // Not realpath'd on purpose: on macOS os.tmpdir() is under /var, a symlink
    // to /private/var, so the registry must store the canonical spelling.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-project-registry-'));
    alpha = path.join(tempDir, 'alpha');
    beta = path.join(tempDir, 'beta');
    fs.mkdirSync(alpha);
    fs.mkdirSync(beta);
  });

  afterEach(() => {
    if (savedStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
    else process.env.CODEGRAPH_STATE_DIR = savedStateDir;
    fs.rmSync(path.join(os.homedir(), '.codegraph', 'projects'), { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('assigns bit 0 to pinned and bit 1 to seeded, and keeps records under ~/.codegraph/projects', async () => {
    const reg = await loadRegistry();
    expect(reg.PROJECT_FLAG_PINNED).toBe(1);
    expect(reg.PROJECT_FLAG_SEEDED).toBe(2);
    expect(reg.registryDir()).toBe(path.join(os.homedir(), '.codegraph', 'projects'));
  });

  it('keeps records under CODEGRAPH_STATE_DIR/projects when it is set, read on every call', async () => {
    const reg = await loadRegistry();
    const stateDir = path.join(tempDir, 'state');
    process.env.CODEGRAPH_STATE_DIR = stateDir;
    // Canonical: tempDir is deliberately not realpath'd here, and the state dir is spelled through its real path.
    expect(reg.registryDir()).toBe(path.join(fs.realpathSync(tempDir), 'state', 'projects'));
    reg.registerProject(alpha);
    expect(fs.readdirSync(path.join(stateDir, 'projects'))).toHaveLength(1);
    expect(reg.getRegisteredProject(alpha)).not.toBeNull();
    // Another state dir has its own registry: it does not see the record.
    process.env.CODEGRAPH_STATE_DIR = path.join(tempDir, 'other-state');
    expect(reg.getRegisteredProject(alpha)).toBeNull();
    // A relative value is refused, never resolved against the working directory.
    process.env.CODEGRAPH_STATE_DIR = 'relative/state';
    expect(() => reg.registryDir()).toThrow(/absolute/);
  });

  it('registers a root under its canonical spelling with an empty bitmap and an ISO8601 date', async () => {
    const reg = await loadRegistry();
    const rec = reg.registerProject(alpha);
    expect(rec.root).toBe(fs.realpathSync.native(alpha));
    expect(rec.commonDir).toBeNull();
    expect(rec.flags).toBe(0);
    expect(rec.registeredAt).toMatch(ISO8601);
    expect(reg.getRegisteredProject(alpha)).toEqual(rec);
    expect(reg.getRegisteredProject(fs.realpathSync(alpha))).toEqual(rec);
    // One JSON record per root, written atomically: no temp file left behind,
    // and the file is named by a hash, not by the root's path.
    const files = fs.readdirSync(reg.registryDir());
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);
    expect(files[0]).not.toContain('alpha');
  });

  it('round-trips register, pin, unpin, list and remove', async () => {
    const reg = await loadRegistry();
    const commonDir = path.join(tempDir, 'repo.git');
    reg.registerProject(alpha, { commonDir });
    expect(reg.isPinned(alpha)).toBe(false);

    const pinned = reg.pinProject(alpha);
    expect(pinned.flags & reg.PROJECT_FLAG_PINNED).not.toBe(0);
    expect(pinned.commonDir).toBe(commonDir);
    expect(reg.isPinned(alpha)).toBe(true);

    // pinProject registers a root that is not registered yet.
    const betaRec = reg.pinProject(beta);
    expect(betaRec.root).toBe(fs.realpathSync.native(beta));
    expect(betaRec.flags).toBe(reg.PROJECT_FLAG_PINNED);

    const roots = reg.listRegisteredProjects().map((p) => p.root).sort();
    expect(roots).toEqual([fs.realpathSync.native(alpha), fs.realpathSync.native(beta)].sort());

    const unpinned = reg.unpinProject(alpha);
    expect(unpinned).not.toBeNull();
    expect(unpinned!.flags & reg.PROJECT_FLAG_PINNED).toBe(0);
    expect(reg.isPinned(alpha)).toBe(false);
    expect(reg.getRegisteredProject(alpha)).not.toBeNull();

    expect(reg.unregisterProject(alpha)).toBe(true);
    expect(reg.unregisterProject(alpha)).toBe(false);
    expect(reg.getRegisteredProject(alpha)).toBeNull();
    expect(reg.unpinProject(alpha)).toBeNull();
    expect(reg.isPinned(alpha)).toBe(false);
    expect(reg.listRegisteredProjects().map((p) => p.root)).toEqual([fs.realpathSync.native(beta)]);
  });

  it('re-registering is idempotent and never clears a set bit', async () => {
    const reg = await loadRegistry();
    const first = reg.pinProject(alpha);
    const again = reg.registerProject(alpha);
    expect(again.flags).toBe(reg.PROJECT_FLAG_PINNED);
    expect(again.registeredAt).toBe(first.registeredAt);

    const seeded = reg.registerProject(alpha, { seeded: true });
    expect(seeded.flags).toBe(reg.PROJECT_FLAG_PINNED | reg.PROJECT_FLAG_SEEDED);

    const notSeeded = reg.registerProject(alpha, { seeded: false });
    expect(notSeeded.flags).toBe(reg.PROJECT_FLAG_PINNED | reg.PROJECT_FLAG_SEEDED);

    // Unpinning clears only the pinned bit.
    expect(reg.unpinProject(alpha)!.flags).toBe(reg.PROJECT_FLAG_SEEDED);
    expect(reg.listRegisteredProjects()).toHaveLength(1);
  });

  it('a given seed nonce replaces the recorded one; registering or pinning without one keeps it', async () => {
    const reg = await loadRegistry();
    expect(reg.registerProject(alpha).seedNonce).toBeUndefined();
    expect(reg.registerProject(alpha, { seeded: true, seedNonce: 'aaaa' }).seedNonce).toBe('aaaa');
    expect(reg.registerProject(alpha, { commonDir: '/some/common' }).seedNonce).toBe('aaaa');
    expect(reg.pinProject(alpha).seedNonce).toBe('aaaa');
    expect(reg.unpinProject(alpha)!.seedNonce).toBe('aaaa');
    // A new seed of the same root brings its own nonce.
    expect(reg.registerProject(alpha, { seeded: true, seedNonce: 'bbbb' }).seedNonce).toBe('bbbb');
    expect(reg.getRegisteredProject(alpha)!.seedNonce).toBe('bbbb');
  });

  it('reads a record without a seed nonce, and skips one whose nonce is not a string', async () => {
    const reg = await loadRegistry();
    const rec = reg.registerProject(alpha, { seeded: true });
    const file = path.join(reg.registryDir(), fs.readdirSync(reg.registryDir()).find((f) => f.endsWith('.json'))!);
    // A record written before the nonce existed has no such key at all.
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))).not.toContain('seedNonce');
    expect(reg.getRegisteredProject(alpha)).toEqual(rec);

    fs.writeFileSync(file, JSON.stringify({ ...rec, seedNonce: 42 }));
    expect(reg.getRegisteredProject(alpha)).toBeNull();
    expect(reg.listRegisteredProjects()).toEqual([]);
  });

  it('readSeedNonce finds no nonce where there is no index', async () => {
    const reg = await loadRegistry();
    expect(reg.readSeedNonce(alpha)).toBeNull();
    expect(() => reg.stampSeedNonce(path.join(alpha, '.codegraph', 'codegraph.db'))).toThrow();
    // A missing database is not created by the attempt.
    expect(fs.existsSync(path.join(alpha, '.codegraph', 'codegraph.db'))).toBe(false);
  });
});

/**
 * Holds the record lock at argv[1] as a live registry client does (its pid,
 * then the ISO8601 time), prints `held`, and after HOLD_MS removes it, exiting
 * 0 only if the lock was still its own when it let go.
 */
const HOLD_MS = 300;
const LOCK_HOLDER = `
const fs = require('fs');
const lock = process.argv[1];
const body = process.pid + '\\n' + new Date().toISOString();
fs.writeFileSync(lock, body, { flag: 'wx' });
process.stdout.write('held\\n');
setTimeout(() => {
  const mine = fs.readFileSync(lock, 'utf8') === body;
  fs.unlinkSync(lock);
  process.exit(mine ? 0 : 2);
}, ${HOLD_MS});
`;

describe('the record lock waits on a time budget', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-project-registry-lock-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(path.join(os.homedir(), '.codegraph', 'projects'), { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Starts one node process that holds the lock for HOLD_MS: well under a
  // second, plus the child's start under load.
  it('a lock that keeps reading as released while a live process holds it does not use the wait up', async () => {
    const reg = await loadRegistry();
    const root = path.join(tempDir, 'project');
    fs.mkdirSync(root);
    reg.registerProject(root);
    const record = fs.readdirSync(reg.registryDir()).find((f) => f.endsWith('.json'))!;
    const lockPath = path.join(reg.registryDir(), `${record}.lock`);

    const holder = spawn(process.execPath, ['-e', LOCK_HOLDER, lockPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    holder.stdout!.on('data', (d) => { out += d; });
    holder.stderr!.on('data', (d) => { err += d; });
    const exited = new Promise<number | null>((resolve) => holder.on('close', (code) => resolve(code)));
    await vi.waitFor(() => expect(out).toContain('held'), { timeout: 30_000 });

    // Every look at the lock after a failed create finds it gone: the
    // immediate retry, earned on every attempt, as under heavy contention.
    const existsSync = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => (p === lockPath ? false : existsSync(p)));
    let rec: ReturnType<Registry['registerProject']> | undefined;
    try {
      rec = reg.registerProject(root, { seeded: true, seedNonce: 'after-the-wait' });
    } finally {
      vi.restoreAllMocks();
    }
    // It waited for the holder (an exclusive create succeeds only once the
    // lock is gone), and never took the lock from it: the holder found its
    // own lock when it let go.
    expect(await exited, err).toBe(0);
    expect(rec!.seedNonce).toBe('after-the-wait');
    expect(reg.getRegisteredProject(root)!.seedNonce).toBe('after-the-wait');
  });
});
