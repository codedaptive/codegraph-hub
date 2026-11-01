/**
 * Answer checkpoints: src/extensions/host/fresh/checkpoint.ts.
 *
 * A checkpoint says which state of the workspace an answer reflects: the git
 * HEAD, a content hash of the uncommitted changes under the project root, and
 * how many source files the index has not caught up with. waitForFresh syncs
 * the index (bounded) until nothing is pending.
 *
 * Every "matches git" expectation is rebuilt here from git's own output
 * (`git rev-parse HEAD`, `git hash-object`, sha256 over `${path}\0${blob}\n`
 * in sorted repo-relative path order), never from the code under test.
 * waitForFresh's bound, lock retry and failure paths run against a stub
 * CheckpointSource.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import {
  type CheckpointSource,
  computeUncommittedHash,
  readCheckpoint,
  readGitHead,
  READ_ONLY_SYNC_ERROR,
  resolveFreshSettleTimeoutMs,
  resolveFreshTimeoutMs,
  waitForFresh,
  waitForFreshTracked,
} from '../../../src/extensions/host/fresh/checkpoint';
import { LockUnavailableError } from '../../../src/sync/watcher';

const DELETED_BLOB = '0'.repeat(40);

/** sha256 hex over `${path}\0${blob}\n` for entries sorted by repo-relative path (the formula in computeUncommittedHash, src/extensions/host/fresh/checkpoint.ts). */
function expectedDirtyHash(entries: Array<[string, string]>): string {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = crypto.createHash('sha256');
  for (const [p, blob] of sorted) h.update(`${p}\0${blob}\n`);
  return h.digest('hex');
}

interface Repo {
  repo: string;
  git: (...args: string[]) => string;
  write: (rel: string, body: string) => void;
}

function makeRepo(prefix: string): Repo {
  return initRepo(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))));
}

/** `git init` in the existing directory `repo`, with a local identity and no signing. */
function initRepo(repo: string): Repo {
  const git = (...args: string[]) =>
    (cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) as string).trim();
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  return { repo, git, write };
}

const A_EDIT = 'export function a() { return 1; }\nexport function freshlyAdded() {}\n';

// Over 5 s possible: each test indexes a fresh repo, and V5 then syncs with a 20 s wait bound; on a
// loaded machine that passes vitest's 5 s default. 30 s covers the setup plus V5's bound.
describe('answer checkpoint', { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  const graphs: CodeGraph[] = [];

  afterEach(() => {
    for (const g of graphs.splice(0)) {
      try { g.close(); } catch { /* already closed */ }
    }
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** Repo with a.ts and c.ts committed (.codegraph/ ignored), indexed. `sub` makes repo/<sub> the project. */
  async function setup(sub = ''): Promise<Repo & { root: string; cg: CodeGraph }> {
    const r = makeRepo('cg-fresh-answers-');
    dirs.push(r.repo);
    const root = sub ? path.join(r.repo, sub) : r.repo;
    const prefix = sub ? `${sub}/` : '';
    r.write('.gitignore', '.codegraph/\n');
    r.write(`${prefix}a.ts`, 'export function a() { return 1; }\n');
    r.write(`${prefix}c.ts`, 'export function c() { return 3; }\n');
    if (sub) r.write('outside.ts', 'export function outside() {}\n');
    r.git('add', '-A');
    r.git('commit', '-qm', 'init');
    const cg = CodeGraph.initSync(root, { config: { include: ['**/*.ts'], exclude: [] } });
    graphs.push(cg);
    await cg.indexAll();
    return { ...r, root, cg };
  }

  it('V1: a clean tree reports git HEAD, no dirty hash, nothing pending, fresh', async () => {
    const { cg, git, root } = await setup();
    const cp1 = await readCheckpoint(cg);
    expect(cp1.head).toBe(git('rev-parse', 'HEAD'));
    expect(readGitHead(root)).toBe(git('rev-parse', 'HEAD'));
    expect(cp1.dirtyHash).toBeNull();
    expect(computeUncommittedHash(root)).toBeNull();
    expect(cp1.pending).toBe(0);
    expect(cp1.fresh).toBe(true);
    expect(cp1.waitedMs).toBe(0);
    expect(cp1.timedOut).toBe(false);
  });

  it('V2: an unsynced edit keeps HEAD, hashes the edited blob, and counts one pending', async () => {
    const { cg, git, write } = await setup();
    const head = git('rev-parse', 'HEAD');
    write('a.ts', A_EDIT);
    const cp2 = await readCheckpoint(cg);
    expect(cp2.head).toBe(head);
    expect(cp2.dirtyHash).toBe(expectedDirtyHash([['a.ts', git('hash-object', 'a.ts')]]));
    expect(cp2.pending).toBe(1);
    expect(cp2.fresh).toBe(false);
  });

  it('V3: an untracked add and a delete join the hash in path order; pending counts all three', async () => {
    const { cg, git, write, repo } = await setup();
    write('a.ts', A_EDIT);
    write('b.ts', 'export function b() { return 2; }\n');
    fs.rmSync(path.join(repo, 'c.ts'));
    const cp3 = await readCheckpoint(cg);
    expect(cp3.dirtyHash).toBe(expectedDirtyHash([
      ['c.ts', DELETED_BLOB],
      ['b.ts', git('hash-object', 'b.ts')],
      ['a.ts', git('hash-object', 'a.ts')],
    ]));
    expect(cp3.pending).toBe(3);
    expect(cp3.fresh).toBe(false);
  });

  it('V4: git add of the edit does not change the dirty hash', async () => {
    const { cg, git, write } = await setup();
    write('a.ts', A_EDIT);
    const before = (await readCheckpoint(cg)).dirtyHash;
    git('add', 'a.ts');
    const after = (await readCheckpoint(cg)).dirtyHash;
    expect(before).not.toBeNull();
    expect(after).toBe(before);
    expect(after).toBe(expectedDirtyHash([['a.ts', git('hash-object', 'a.ts')]]));
  });

  it('V5: waitForFresh syncs the edit in, reports fresh, and the new symbol is searchable', async () => {
    const { cg, git, write } = await setup();
    write('a.ts', A_EDIT);
    const dirtyBefore = (await readCheckpoint(cg)).dirtyHash;
    const cp5 = await waitForFresh(cg, { timeoutMs: 20_000, sync: () => cg.sync() });
    expect(cp5.fresh).toBe(true);
    expect(cp5.pending).toBe(0);
    expect(cp5.timedOut).toBe(false);
    expect(cp5.syncError).toBeUndefined();
    expect(cp5.head).toBe(git('rev-parse', 'HEAD'));
    expect(cp5.dirtyHash).toBe(dirtyBefore);
    expect(cg.searchNodes('freshlyAdded').some((r) => r.node.name === 'freshlyAdded')).toBe(true);
  });

  it('V6: timeoutMs 0 with a pending edit returns not fresh and timed out, without throwing', async () => {
    const { cg, write } = await setup();
    write('a.ts', A_EDIT);
    const cp6 = await waitForFresh(cg, { timeoutMs: 0, sync: () => cg.sync() });
    expect(cp6.fresh).toBe(false);
    expect(cp6.timedOut).toBe(true);
    expect(cp6.pending).toBe(1);
    expect(cg.searchNodes('freshlyAdded').some((r) => r.node.name === 'freshlyAdded')).toBe(false);
  });

  it('V7: a read-only instance resolves not fresh with a syncError', async () => {
    const { cg, root, write } = await setup();
    cg.close();
    const ro = await CodeGraph.open(root, { readOnly: true });
    graphs.push(ro);
    write('a.ts', A_EDIT);
    // Its caller's sync is its own write, so even one handed in fails on the read-only database.
    const cp7 = await waitForFresh(ro, { timeoutMs: 5_000, sync: () => ro.sync() });
    expect(cp7.fresh).toBe(false);
    expect(typeof cp7.syncError).toBe('string');
    expect(cp7.syncError!.length).toBeGreaterThan(0);
  });

  it('V7b: with no sync to run the wait only measures and says the session holds the index read-only', async () => {
    const { cg, root, write } = await setup();
    cg.close();
    const ro = await CodeGraph.open(root, { readOnly: true });
    graphs.push(ro);
    write('a.ts', A_EDIT);
    const cp = await waitForFresh(ro, { timeoutMs: 5_000 });
    expect(cp.fresh).toBe(false);
    expect(cp.pending).toBe(1);
    expect(cp.timedOut).toBe(false);
    expect(cp.syncError).toBe(READ_ONLY_SYNC_ERROR);
    // Measuring only, not waiting out the 5 s bound (the measure itself takes a git status's time under load).
    expect(cp.waitedMs).toBeLessThan(5_000);
  });

  it('V8: in a subdir project an edit outside the project does not change the dirty hash', async () => {
    const { cg, git, write, root } = await setup('pkg');
    write('pkg/a.ts', A_EDIT);
    const inside = (await readCheckpoint(cg)).dirtyHash;
    // Paths are repo-relative, as git status prints them.
    expect(inside).toBe(expectedDirtyHash([['pkg/a.ts', git('hash-object', 'pkg/a.ts')]]));
    write('outside.ts', 'export function outside() { return 42; }\n');
    write('stray.ts', 'export function stray() {}\n');
    expect((await readCheckpoint(cg)).dirtyHash).toBe(inside);
    expect(computeUncommittedHash(root)).toBe(inside);
  });

  it('V9: outside a git repo head and dirtyHash are null', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fresh-nogit-')));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function a() {}\n');
    expect(readGitHead(dir)).toBeNull();
    expect(computeUncommittedHash(dir)).toBeNull();
    const cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    graphs.push(cg);
    await cg.indexAll();
    const cp9 = await readCheckpoint(cg);
    expect(cp9.head).toBeNull();
    expect(cp9.dirtyHash).toBeNull();
  });
});

/**
 * Filenames git's line-based `--stdin-paths` would rewrite: a leading `"` is
 * C-unquoted, a trailing CR is stripped, an LF splits the name in two. Each
 * blob must still be the hash of THAT working-tree file, so the expectation
 * passes the literal path on argv (`git hash-object -- <path>`), which git
 * never unquotes. F-03 puts the CR at the end of the repository root's own
 * name instead, which reaches the hash through the line `git rev-parse
 * --show-toplevel` prints. Windows forbids `"`, CR and LF in filenames.
 */
describe('computeUncommittedHash: filenames round-trip to their own blobs', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A repo with a.ts committed; no index needed, the hash reads git only. */
  function committedRepo(): Repo {
    const r = makeRepo('cg-fresh-names-');
    dirs.push(r.repo);
    r.write('a.ts', 'export function a() { return 1; }\n');
    r.git('add', '-A');
    r.git('commit', '-qm', 'init');
    return r;
  }

  it.runIf(process.platform !== 'win32')(
    'F-01: an untracked `"a.ts"` beside a tracked a.ts hashes its own bytes, and editing it changes the hash',
    () => {
      const { repo, git, write } = committedRepo();
      const quoted = '"a.ts"';
      write(quoted, 'export const q = 1;\n');
      const first = computeUncommittedHash(repo);
      expect(first).toBe(expectedDirtyHash([[quoted, git('hash-object', '--', quoted)]]));
      write(quoted, 'export const q = 2;\n');
      const second = computeUncommittedHash(repo);
      expect(second).toBe(expectedDirtyHash([[quoted, git('hash-object', '--', quoted)]]));
      expect(second).not.toBe(first);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'names with LF, a trailing CR, a backslash, a leading quote and non-ASCII each hash their own file',
    () => {
      const { repo, git, write } = committedRepo();
      const names = ['line\nbreak.ts', 'trailing.ts\r', 'back\\slash.ts', '"lead.ts', 'café.ts', 'sub/"q\t.ts"'];
      names.forEach((n, i) => write(n, `export const v${i} = ${i};\n`));
      write('a.ts', 'export function a() { return 2; }\n');
      const entries: Array<[string, string]> = [...names, 'a.ts'].map(n => [n, git('hash-object', '--', n)]);
      expect(computeUncommittedHash(repo)).toBe(expectedDirtyHash(entries));
    },
  );

  it.runIf(process.platform !== 'win32')(
    'F-03: in a repository whose root directory name ends in CR, each edit of a.ts hashes as its own blob',
    () => {
      // git prints the top-level as `<root>\n`; the CR before that LF belongs to the directory's name.
      const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fresh-cr-root-')));
      dirs.push(parent);
      const repo = path.join(parent, 'repo\r');
      fs.mkdirSync(repo);
      const { git, write } = initRepo(repo);
      write('a.ts', 'export function a() { return 1; }\n');
      git('add', '-A');
      git('commit', '-qm', 'init');
      write('a.ts', 'export function a() { return 2; }\n');
      const first = computeUncommittedHash(repo);
      expect(first).toBe(expectedDirtyHash([['a.ts', git('hash-object', '--', 'a.ts')]]));
      write('a.ts', 'export function a() { return 3; }\n');
      const second = computeUncommittedHash(repo);
      expect(second).toBe(expectedDirtyHash([['a.ts', git('hash-object', '--', 'a.ts')]]));
      expect(second).not.toBe(first);
    },
  );

  it('a name that is not valid UTF-8 hashes its own bytes, where the filesystem allows one', (ctx) => {
    const { repo } = committedRepo();
    const name = Buffer.from([0x62, 0xff, 0x2e, 0x74, 0x73]); // `b<0xff>.ts`
    const body = 'export const raw = 1;\n';
    try {
      fs.writeFileSync(Buffer.concat([Buffer.from(`${repo}/`), name]), body);
    } catch {
      // APFS and NTFS refuse a name that is not valid UTF-8; Linux filesystems take any bytes.
      ctx.skip();
      return;
    }
    // Node's argv cannot carry the raw byte, so the blob comes from the content (no filters are set).
    const blob = (cp.execFileSync('git', ['hash-object', '--stdin'], { cwd: repo, input: body, encoding: 'utf8' }) as string).trim();
    const expected = crypto.createHash('sha256').update(Buffer.concat([name, Buffer.from(`\0${blob}\n`)])).digest('hex');
    expect(computeUncommittedHash(repo)).toBe(expected);
  });
});

/**
 * A gate a stub sync awaits. It stays closed until the test calls `release`, so a sync the test
 * describes as still running is still running by construction, whatever the machine's load. The test
 * calls `release` only after the assertions that need the sync running.
 */
function makeGate(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { gate, release };
}

/**
 * The bounded wait's control flow, against a stub CheckpointSource: no index,
 * no SQLite. The stub's root is a directory outside git, so each checkpoint's
 * git fields are null and cost one failed git spawn each.
 */
describe('waitForFresh against a stub source: the bound, lock retry, and a real failure', () => {
  /**
   * The wait's bound in the tests that time out: short, so they stay fast. Nothing else depends on its
   * size: the sync that loses the race waits on a gate, not on a timer.
   */
  const BOUND_MS = 100;
  /** Node may fire a timer up to ~1 ms early by Date.now(), which waitedMs is measured with. */
  const TIMER_SLACK_MS = 2;
  /** The pause between lock retries: small, so the retry tests stay fast. */
  const POLL_MS = 10;
  /** A bound the retry and failure tests never reach; reaching it would fail them on timedOut. */
  const GENEROUS_MS = 10_000;

  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  /** A source whose pending count is `state.pending`, with the `sync` the wait is handed. */
  function stubSource(sync: () => Promise<unknown>, state = { pending: 1 }): CheckpointSource & { sync: () => Promise<unknown> } {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fresh-stub-')));
    dirs.push(root);
    return {
      getProjectRoot: () => root,
      getChangedFiles: () => ({
        added: [], modified: Array.from({ length: state.pending }, (_, i) => `f${i}.ts`), removed: [],
      }),
      sync,
    };
  }

  it('a sync still running when the bound passes ends the wait timed out, not fresh', async () => {
    let calls = 0;
    const src = stubSource(() => { calls++; return new Promise<never>(() => { /* never settles */ }); });
    const out = await waitForFresh(src, { timeoutMs: BOUND_MS, sync: src.sync });
    expect(out.timedOut).toBe(true);
    expect(out.fresh).toBe(false);
    expect(out.pending).toBe(1);
    expect(out.syncError).toBeUndefined();
    expect(out.waitedMs).toBeGreaterThanOrEqual(BOUND_MS - TIMER_SLACK_MS);
    expect(calls).toBe(1);
  });

  it('a sync that loses the race and rejects later raises no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      let rejected = false;
      // The sync holds at `gate` until the test releases it, after the "not yet rejected" assertion.
      const { gate, release } = makeGate();
      // Opens just before the sync throws, so the test can wait for the rejection without a timer.
      const { gate: rejecting, release: markRejecting } = makeGate();
      const src = stubSource(async () => {
        await gate;
        rejected = true;
        markRejecting();
        throw new Error('late failure');
      });
      const out = await waitForFresh(src, { timeoutMs: BOUND_MS, sync: src.sync });
      expect(out.timedOut).toBe(true);
      expect(out.syncError).toBeUndefined();
      expect(rejected).toBe(false);
      release();
      await rejecting;
      // Node reports an unhandled rejection once the microtask queue drains, before the next timer
      // fires, so one turn after the rejection is enough for it to be reported.
      await sleep(0);
      expect(rejected).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('lock contention, matched by error name, is retried until a sync succeeds', async () => {
    const state = { pending: 2 };
    let calls = 0;
    const src = stubSource(async () => {
      calls++;
      if (calls === 1) {
        // A plain Error carrying only the name: the match is by name, not class.
        const err = new Error('held by another writer');
        err.name = 'LockUnavailableError';
        throw err;
      }
      if (calls === 2) throw new LockUnavailableError();
      state.pending = 0;
    }, state);
    const out = await waitForFresh(src, { timeoutMs: GENEROUS_MS, pollMs: POLL_MS, sync: src.sync });
    expect(calls).toBe(3);
    expect(out.fresh).toBe(true);
    expect(out.pending).toBe(0);
    expect(out.timedOut).toBe(false);
    expect(out.syncError).toBeUndefined();
  });

  it('a sync failure other than lock contention stops the wait at once with its message', async () => {
    let calls = 0;
    const src = stubSource(async () => { calls++; throw new Error('disk I/O error'); });
    const out = await waitForFresh(src, { timeoutMs: GENEROUS_MS, pollMs: POLL_MS, sync: src.sync });
    expect(calls).toBe(1);
    expect(out.syncError).toBe('disk I/O error');
    expect(out.fresh).toBe(false);
    expect(out.pending).toBe(1);
    expect(out.timedOut).toBe(false);
  });
});

/**
 * waitForFreshTracked: the same wait, plus `settled`, which resolves once no
 * sync the wait started is still running. Same stub shape as the block above.
 *
 * The stub sync does not sleep: it awaits a gate the test opens itself, and
 * the test opens it only after its "still pending" assertions. A real sleep
 * raced the probe under load (a stall longer than the sleep let the sync
 * finish before the assertions ran); the gate keeps the same claim, that the
 * sync has not finished when the wait's bound passes, by construction.
 */
describe('waitForFreshTracked against a stub source: settled follows the sync that lost the race', () => {
  /** The wait's bound: short, but far above timer granularity. */
  const BOUND_MS = 50;

  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  function stubSource(sync: () => Promise<unknown>): CheckpointSource & { sync: () => Promise<unknown> } {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fresh-tracked-')));
    dirs.push(root);
    return {
      getProjectRoot: () => root,
      getChangedFiles: () => ({ added: [], modified: ['f0.ts'], removed: [] }),
      sync,
    };
  }

  /** Whether `p` has resolved by the next macrotask. */
  async function isResolved(p: Promise<void>): Promise<boolean> {
    let done = false;
    void p.then(() => { done = true; });
    await sleep(0);
    return done;
  }

  it('settled is pending when the wait times out and resolves once the late sync resolves', async () => {
    let syncDone = false;
    const { gate, release } = makeGate();
    const src = stubSource(async () => { await gate; syncDone = true; });
    const { checkpoint, settled } = await waitForFreshTracked(src, { timeoutMs: BOUND_MS, sync: src.sync });
    expect(checkpoint.timedOut).toBe(true);
    expect(checkpoint.fresh).toBe(false);
    expect(syncDone).toBe(false);
    expect(await isResolved(settled)).toBe(false);
    release();
    await settled;
    expect(syncDone).toBe(true);
  });

  it('settled still resolves, with no unhandled rejection, when the late sync rejects', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      let rejected = false;
      const { gate, release } = makeGate();
      const src = stubSource(async () => {
        await gate;
        rejected = true;
        throw new Error('late failure');
      });
      const { checkpoint, settled } = await waitForFreshTracked(src, { timeoutMs: BOUND_MS, sync: src.sync });
      expect(checkpoint.timedOut).toBe(true);
      expect(checkpoint.syncError).toBeUndefined();
      expect(rejected).toBe(false);
      expect(await isResolved(settled)).toBe(false);
      release();
      await expect(settled).resolves.toBeUndefined();
      expect(rejected).toBe(true);
      await sleep(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('resolveFreshSettleTimeoutMs', () => {
  it('U2 defaults to 600000 when unset', () => {
    expect(resolveFreshSettleTimeoutMs(undefined)).toBe(600000);
    expect(resolveFreshSettleTimeoutMs()).toBe(600000);
  });

  it('U2 honours 0', () => {
    expect(resolveFreshSettleTimeoutMs('0')).toBe(0);
  });

  it('U2 falls back to 600000 for a non-numeric value', () => {
    expect(resolveFreshSettleTimeoutMs('x')).toBe(600000);
  });

  it('U2 clamps to 3600000', () => {
    expect(resolveFreshSettleTimeoutMs('99999999')).toBe(3600000);
  });
});

describe('resolveFreshTimeoutMs', () => {
  it('defaults to 30000 when unset', () => {
    expect(resolveFreshTimeoutMs(undefined)).toBe(30000);
    expect(resolveFreshTimeoutMs()).toBe(30000);
  });

  it('honours 0 (no wait)', () => {
    expect(resolveFreshTimeoutMs('0')).toBe(0);
  });

  it('falls back to 30000 for a negative or non-numeric value', () => {
    expect(resolveFreshTimeoutMs('-5')).toBe(30000);
    expect(resolveFreshTimeoutMs('abc')).toBe(30000);
  });

  it('clamps to 600000', () => {
    expect(resolveFreshTimeoutMs('9999999')).toBe(600000);
  });
});
