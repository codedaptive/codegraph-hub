/**
 * The builder's CLI requests (src/extensions/host/builder/cli-wire.ts) and the CLI's running check
 * (cli-route.ts, `builderRoute`):
 *   - `fence` / `unfence`: the rebuild lease a `codegraph index` holds through the server;
 *   - `cliIndex` (modes init, rebuild, reindex, reindex-leased): one job each on the builder's queue, with
 *     `requestEvent` pushes for the events of an init;
 *   - `cliSync`: one sync of a root as a job, answering the full SyncResult;
 *   - `builderRoute()`: whether a machine server with its builder up is running for a state dir.
 *   - `fence {kind}` / `drain`: a release fence (`uninit`'s) refuses the root's new CLI sync and reindex jobs at
 *     their start (a request that arrives after the fence is refused when it is made, one queued before it when it starts),
 *     and `drain` answers once no job of its root runs or waits, a seed that reads the root included (U9).
 *
 * Run in-process, as builder-service.test.ts drives BuilderService: a recording `send`, the job log through the
 * `jobLog` seam, housekeeping off, real SQLite and real files in mkdtemp dirs. The requests are the IPC shapes
 * the server sends (`{id, op, ...}` through BuilderService.handle). What is checked is what the builder sends
 * back (`{id, ok, result | error}` replies, `{op: 'requestEvent', requestId, event}` pushes) and the job log.
 * The fence registry, the queue and the holder are not reached into.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import CodeGraph from '../../../src/index';
import { BuilderService } from '../../../src/extensions/host/builder/service';

/** A pid no process holds: a lock or builder record naming it belongs to a process that is gone. */
const DEAD_PID = 999999;

/**
 * The module under test, by an absolute specifier and a dynamic import: a missing module fails only the cases
 * that load it, not the whole file's load.
 */
const CLI_ROUTE = path.resolve(__dirname, '../../../src/extensions/host/builder/cli-route');

/** What the builder sends: a reply (`id` with `ok`), a push, or a request's event (`requestId` and no `id`). */
interface Outbound {
  id?: number;
  ok?: boolean;
  op?: string;
  requestId?: number;
  event?: { kind: string; progress?: { phase: string; current: number; total: number } };
  result?: unknown;
  error?: string;
}

function real(p: string): string {
  return fs.realpathSync(path.resolve(p));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntil(check: () => boolean, timeoutMs: number, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return check();
}

/** The pid a lock record names, read as it was written; null when there is no record or it does not parse. */
function lockPid(root: string, name: 'rebuild.pid' | 'writer.pid'): number | null {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(root, '.codegraph', name), 'utf8')) as { pid?: unknown };
    return typeof record.pid === 'number' ? record.pid : null;
  } catch {
    return null;
  }
}

/** A project of `files` small source files, indexed. */
async function indexedProject(dir: string, files = 1): Promise<void> {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (let i = 0; i < files; i++) {
    fs.writeFileSync(path.join(dir, 'src', `f${i}.ts`), `export function f${i}() { return ${i}; }\n`);
  }
  const cg = await CodeGraph.init(dir);
  try { await cg.indexAll(); } finally { cg.close(); }
}

/**
 * Adds `count` source files to `root` after its index was built, so a sync of the root has `count` files to read and
 * runs for a while. They are new rather than changed: the sync reads either kind, and indexing 150 files up front would
 * cost each case that uses this several seconds more.
 */
function addFiles(root: string, count: number): void {
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(root, 'src', `added${i}.ts`), `export function added${i}() { return ${i}; }\n`);
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** A git repository at `dir` with three small files and one commit, then indexed: a seed source. */
async function indexedRepo(dir: string): Promise<void> {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, 'src', `s${i}.ts`), `export function s${i}() { return ${i}; }\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  const cg = await CodeGraph.init(dir);
  try { await cg.indexAll(); } finally { cg.close(); }
}

/** Load builderRoute. Dynamic, so a missing module fails the cases that call it. */
async function loadBuilderRoute(): Promise<() => Promise<unknown>> {
  const mod = (await import(/* @vite-ignore */ CLI_ROUTE)) as { builderRoute: () => Promise<unknown> };
  return mod.builderRoute;
}

describe('the builder CLI requests', { timeout: 60_000 }, () => {
  let workspace: string;
  let service: BuilderService | undefined;
  let sent: Outbound[];
  let jobLines: string[];
  let children: ChildProcess[];

  beforeEach(() => {
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-builder-cli-route-')));
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    sent = [];
    jobLines = [];
    children = [];
  });

  afterEach(async () => {
    await service?.stop(0);
    service = undefined;
    for (const child of children) child.kill('SIGKILL');
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 30_000);

  function startService(housekeeping = false): BuilderService {
    service = new BuilderService({
      send: (message) => { sent.push(message as unknown as Outbound); },
      jobLog: (line) => { jobLines.push(line); },
      log: () => { /* diagnostics are not under test */ },
      watchOptions: () => ({ debounceMs: 100 }),
      timing: { pollMs: 25, ownRetryMs: 50, recoverWaitMs: 1_000, seedWaitMs: 1_000 },
      housekeeping,
    });
    return service;
  }

  /** One request as the server sends it. Resolves once the builder has sent that request's reply. */
  const ask = (svc: BuilderService, request: { id: number; op: string } & Record<string, unknown>) =>
    svc.handle(request as unknown as Parameters<BuilderService['handle']>[0]);

  const replyTo = (id: number): Outbound | undefined =>
    sent.find((m) => m.id === id && typeof m.ok === 'boolean');
  const replyIndex = (id: number): number =>
    sent.findIndex((m) => m.id === id && typeof m.ok === 'boolean');
  const eventsFor = (requestId: number): Outbound[] =>
    sent.filter((m) => m.op === 'requestEvent' && m.requestId === requestId);

  /** The job log's end line for `kind` on `root`, ok. The log lines carry an ISO stamp before the kind. */
  const jobOk = (kind: string, root: string): boolean =>
    jobLines.some((l) => l.endsWith(` job end ${kind} ${root} ok`));
  const jobStarted = (kind: string, root: string): boolean =>
    jobLines.some((l) => l.endsWith(` job start ${kind} ${root}`));
  const countJobEnds = (kind: string): number =>
    jobLines.filter((l) => l.includes(` job end ${kind} `)).length;

  /** A live process that is not this one, to name in a lock record as another writer. */
  function otherLiveProcess(): ChildProcess {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
    children.push(child);
    return child;
  }

  // ---- U1 / U2: cliSync ----

  it('U1 cliSync on an indexed root that no service holds answers a full SyncResult, through a sync job', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    const r = real(root);
    const svc = startService();
    expect(svc.holders.has(r), 'premise: nothing is held').toBe(false);
    fs.writeFileSync(path.join(root, 'src', 'added.ts'), 'export function added() { return 3; }\n');

    await ask(svc, { id: 1, op: 'cliSync', root: r });

    expect(replyTo(1)).toMatchObject({
      id: 1,
      ok: true,
      result: {
        filesAdded: 1,
        filesModified: expect.any(Number),
        filesRemoved: expect.any(Number),
        filesChecked: expect.any(Number),
        nodesUpdated: expect.any(Number),
        durationMs: expect.any(Number),
      },
    });
    expect(jobOk('sync', r), 'the job log has a sync job for this root').toBe(true);
  });

  it('U2 cliSync on a root this service holds answers the same SyncResult shape, and the existing sync op still answers filesChanged', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    const r = real(root);
    const svc = startService();
    expect(await svc.ensure(r)).toEqual({ kind: 'ready', root: r });
    await svc.holders.caughtUp(r);

    await ask(svc, { id: 1, op: 'sync', root: r });
    expect(replyTo(1)).toMatchObject({ id: 1, ok: true, result: { filesChanged: expect.any(Number) } });

    fs.writeFileSync(path.join(root, 'src', 'added.ts'), 'export function added() { return 3; }\n');
    const syncEndsBefore = countJobEnds('sync');
    await ask(svc, { id: 2, op: 'cliSync', root: r });
    expect(replyTo(2)).toMatchObject({
      id: 2,
      ok: true,
      result: {
        filesChecked: expect.any(Number),
        filesAdded: expect.any(Number),
        filesModified: expect.any(Number),
        filesRemoved: expect.any(Number),
        nodesUpdated: expect.any(Number),
        durationMs: expect.any(Number),
      },
    });
    // Counted against the sync op's own job above: exactly one more sync job ended, the cliSync's.
    expect(countJobEnds('sync'), 'one more sync job ended for the cliSync').toBe(syncEndsBefore + 1);
  });

  // ---- U3: cliIndex init ----

  it('U3 cliIndex init on a directory with no index: initialized first, then progress, all as requestEvent pushes with no id; an IndexResult; no rebuild.pid; an init job', async () => {
    const root = path.join(workspace, 'fresh');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a() { return 1; }\n');
    const r = real(root);
    const svc = startService();
    expect(fs.existsSync(path.join(r, '.codegraph')), 'premise: not indexed').toBe(false);

    await ask(svc, { id: 3, op: 'cliIndex', root: r, mode: 'init' });

    expect(replyTo(3)).toMatchObject({ id: 3, ok: true, result: { success: true, nodesCreated: expect.any(Number) } });
    expect((replyTo(3)?.result as { nodesCreated: number }).nodesCreated).toBeGreaterThan(0);

    const events = eventsFor(3);
    expect(events[0], 'the first event is initialized').toEqual({
      op: 'requestEvent',
      requestId: 3,
      event: { kind: 'initialized' },
    });
    const progress = events.slice(1);
    expect(progress.length, 'progress events follow initialized').toBeGreaterThan(0);
    for (const e of progress) {
      expect(e.event?.kind).toBe('progress');
      expect(typeof e.event?.progress?.phase).toBe('string');
    }
    // Every requestEvent push belongs to this request, and none carries an `id` (it is not a reply).
    const pushes = sent.filter((m) => m.op === 'requestEvent');
    expect(pushes).toHaveLength(events.length);
    for (const push of pushes) expect(Object.keys(push)).not.toContain('id');
    // The reply comes after the last event.
    const lastEventAt = Math.max(-1, ...sent.flatMap((m, i) => (m.op === 'requestEvent' ? [i] : [])));
    expect(replyIndex(3)).toBeGreaterThan(lastEventAt);

    expect(fs.existsSync(path.join(r, '.codegraph', 'rebuild.pid')), 'no rebuild.pid for an init').toBe(false);
    expect(jobStarted('init', r), 'the job log has the init job starting').toBe(true);
    expect(jobOk('init', r), 'the init job ended ok').toBe(true);
  });

  // ---- U4: fence lifecycle ----

  it('U4 fence: a second fence is refused, ensure answers building while fenced, the rebuild runs under the lease, and unfence releases both lock files', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    const r = real(root);
    const svc = startService();

    await ask(svc, { id: 1, op: 'fence', root: r });
    expect(replyTo(1)).toMatchObject({ id: 1, ok: true });
    expect(lockPid(r, 'rebuild.pid')).toBe(process.pid);

    await ask(svc, { id: 2, op: 'fence', root: r });
    expect(replyTo(2)).toMatchObject({ id: 2, ok: false, error: 'Another index rebuild is already in progress.' });

    expect(await svc.ensure(r)).toEqual({ kind: 'building', root: r });

    await ask(svc, { id: 3, op: 'cliIndex', root: r, mode: 'rebuild' });
    expect(replyTo(3)).toMatchObject({ id: 3, ok: true, result: { success: true } });
    expect(jobOk('index', r), 'the rebuild ran as an index job').toBe(true);
    expect(lockPid(r, 'rebuild.pid'), 'the lease keeps rebuild.pid').toBe(process.pid);
    expect(lockPid(r, 'writer.pid'), 'the lease keeps writer.pid').toBe(process.pid);

    await ask(svc, { id: 4, op: 'unfence', root: r });
    expect(replyTo(4)).toMatchObject({ id: 4, ok: true });
    expect(fs.existsSync(path.join(r, '.codegraph', 'rebuild.pid')), 'rebuild.pid released').toBe(false);
    expect(fs.existsSync(path.join(r, '.codegraph', 'writer.pid')), 'writer.pid released').toBe(false);

    await ask(svc, { id: 5, op: 'cliIndex', root: r, mode: 'rebuild' });
    expect(replyTo(5), 'a rebuild with no fence is refused').toMatchObject({ id: 5, ok: false });
  });

  // ---- U5: fence refusals and reclaim ----

  it('U5 fence is refused while another live process names rebuild.pid, and that record is left as it is', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    const r = real(root);
    const other = otherLiveProcess();
    expect(typeof other.pid, 'premise: a live child').toBe('number');
    expect(pidAlive(other.pid as number), 'premise: the child is alive').toBe(true);
    // The record as writer-lock.ts writes it: its fields as JSON and a newline.
    fs.writeFileSync(
      path.join(r, '.codegraph', 'rebuild.pid'),
      JSON.stringify({ pid: other.pid, mode: 'rebuild', startedAt: Date.now(), root: r }) + '\n',
    );
    const svc = startService();

    await ask(svc, { id: 1, op: 'fence', root: r });
    expect(replyTo(1)).toMatchObject({ id: 1, ok: false, error: 'Another index rebuild is already in progress.' });
    expect(lockPid(r, 'rebuild.pid')).toBe(other.pid);
  });

  it('U5 fence reclaims a rebuild.pid that names this process when no rebuild job is running', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    const r = real(root);
    fs.writeFileSync(
      path.join(r, '.codegraph', 'rebuild.pid'),
      JSON.stringify({ pid: process.pid, mode: 'rebuild', startedAt: Date.now(), root: r }) + '\n',
    );
    const svc = startService();

    await ask(svc, { id: 1, op: 'fence', root: r });
    expect(replyTo(1)).toMatchObject({ id: 1, ok: true });
    expect(lockPid(r, 'rebuild.pid')).toBe(process.pid);
  });

  // A fence is refused while a cold build of this process holds rebuild.pid. The build is the real one (seed.ts
  // queues it, runColdBuild takes rebuild.pid under this pid); CODEGRAPH_BUILDER_COLD_BUILD_DELAY_MS holds it open
  // after it took the record and before the database.
  it('U5 fence is refused while a cold build of this process holds rebuild.pid', async () => {
    vi.stubEnv('CODEGRAPH_BUILDER_COLD_BUILD_DELAY_MS', '1500');
    const plain = path.join(workspace, 'plain');
    fs.mkdirSync(path.join(plain, 'src'), { recursive: true });
    fs.writeFileSync(path.join(plain, 'src', 'a.ts'), 'export function a() { return 1; }\n');
    const r = real(plain);
    const svc = startService();

    expect(await svc.ensure(r), 'premise: an unbuilt directory queues a cold build').toEqual({ kind: 'building', root: r });
    expect(
      await waitUntil(() => lockPid(r, 'rebuild.pid') === process.pid, 10_000),
      'the cold build took rebuild.pid under this pid',
    ).toBe(true);

    await ask(svc, { id: 1, op: 'fence', root: r });
    expect(replyTo(1)).toMatchObject({ id: 1, ok: false, error: 'Another index rebuild is already in progress.' });
    expect(lockPid(r, 'rebuild.pid'), 'the build still holds its record').toBe(process.pid);

    // Let the build finish, so teardown does not race it.
    expect(await waitUntil(() => jobLines.some((l) => / job end cold-build /.test(l)), 30_000)).toBe(true);
  });

  // ---- U6: unfence waits for a running lease job ----

  // The rebuild runs for as long as it takes to index 150 files (one progress event per parsed file), so the
  // unfence arrives while it is inside indexAll with writer.pid taken. That window is what the case is about; the
  // indexing is why this case runs for several seconds.
  it('U6 unfence waits for a running lease job: its reply follows the job, writer.pid stays until the job ends, and a reindex-leased queued after unfence errors', async () => {
    const root = path.join(workspace, 'big');
    await indexedProject(root, 150);
    const r = real(root);
    const svc = startService();

    await ask(svc, { id: 1, op: 'fence', root: r });
    expect(replyTo(1)).toMatchObject({ id: 1, ok: true });

    const rebuilding = ask(svc, { id: 2, op: 'cliIndex', root: r, mode: 'rebuild' });
    const inside = await waitUntil(
      () => eventsFor(2).some((m) => m.event?.kind === 'progress') && lockPid(r, 'writer.pid') === process.pid,
      20_000,
    );
    expect(inside, 'the rebuild reached a progress event with writer.pid taken').toBe(true);

    let unfenced = false;
    const unfencing = ask(svc, { id: 3, op: 'unfence', root: r }).then(() => { unfenced = true; });
    const runningAtUnfence = !jobLines.some((l) => / job end index /.test(l));
    const lateLease = ask(svc, { id: 4, op: 'cliIndex', root: r, mode: 'reindex-leased' });

    // Sample writer.pid until unfence answers. Only the rebuild's end line may let it go, so a sample with no end
    // line and no writer.pid of ours is a violation. (A polling sampler: the point is to look during the window.)
    let vanishedWhileRunning = 0;
    const deadline = Date.now() + 30_000;
    while (!unfenced && Date.now() < deadline) {
      const ended = jobLines.some((l) => / job end index /.test(l));
      if (!ended && lockPid(r, 'writer.pid') !== process.pid) vanishedWhileRunning++;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Promise.all([rebuilding, unfencing, lateLease]);

    expect(runningAtUnfence, 'the rebuild job was still running when unfence arrived').toBe(true);
    expect(vanishedWhileRunning, 'writer.pid was not removed while the rebuild job ran').toBe(0);
    expect(unfenced, 'unfence answered').toBe(true);
    expect(replyTo(2)).toMatchObject({ id: 2, ok: true, result: { success: true } });
    expect(replyIndex(3), 'unfence answered after the rebuild did').toBeGreaterThan(replyIndex(2));
    expect(replyTo(4), 'a reindex-leased queued after unfence errors: the lease ended').toMatchObject({
      id: 4,
      ok: false,
      error: expect.stringMatching(/lease/),
    });
    expect(fs.existsSync(path.join(r, '.codegraph', 'rebuild.pid')), 'rebuild.pid released').toBe(false);
    expect(fs.existsSync(path.join(r, '.codegraph', 'writer.pid')), 'writer.pid released').toBe(false);
  });

  // ---- U7: stop releases fences ----

  it('U7 stop releases every fence: rebuild.pid is gone once the service has stopped', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    const r = real(root);
    const svc = startService();

    await ask(svc, { id: 1, op: 'fence', root: r });
    expect(replyTo(1)).toMatchObject({ id: 1, ok: true });
    expect(lockPid(r, 'rebuild.pid')).toBe(process.pid);

    await svc.stop(0);
    service = undefined;
    expect(fs.existsSync(path.join(r, '.codegraph', 'rebuild.pid'))).toBe(false);
  });

  // ---- U8: builderRoute, the CLI's running check ----

  describe('U8 builderRoute', () => {
    it('is null for a state dir with no server, and creates no entry in it', async () => {
      const stateDir = path.join(workspace, 'empty');
      fs.mkdirSync(stateDir);
      vi.stubEnv('CODEGRAPH_STATE_DIR', stateDir);
      const builderRoute = await loadBuilderRoute();
      const before = fs.readdirSync(stateDir);

      await expect(builderRoute()).resolves.toBeNull();
      expect(fs.readdirSync(stateDir)).toEqual(before);
    });

    it('is null for a state dir that does not exist, and creates none of it', async () => {
      const parent = path.join(workspace, 'never-made');
      vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(parent, 'state'));
      const builderRoute = await loadBuilderRoute();

      await expect(builderRoute()).resolves.toBeNull();
      expect(fs.existsSync(parent), 'nothing was created').toBe(false);
    });

    it('is null for a relative state dir, without throwing and without creating it', async () => {
      const name = `cg-u8-relative-${process.pid}`;
      vi.stubEnv('CODEGRAPH_STATE_DIR', name);
      const builderRoute = await loadBuilderRoute();
      try {
        await expect(builderRoute()).resolves.toBeNull();
        expect(fs.existsSync(path.resolve(name)), 'nothing was created in the working directory').toBe(false);
      } finally {
        fs.rmSync(path.resolve(name), { recursive: true, force: true });
      }
    });

    it('is null when builder.pid names a dead pid and no server is running', async () => {
      const stateDir = path.join(workspace, 'state-dead');
      fs.mkdirSync(stateDir);
      fs.writeFileSync(
        path.join(stateDir, 'builder.pid'),
        JSON.stringify({ pid: DEAD_PID, serverPid: DEAD_PID, startedAt: new Date().toISOString() }) + '\n',
      );
      expect(pidAlive(DEAD_PID), 'premise: the pid is dead').toBe(false);
      vi.stubEnv('CODEGRAPH_STATE_DIR', stateDir);
      const builderRoute = await loadBuilderRoute();
      const before = fs.readdirSync(stateDir).sort();

      await expect(builderRoute()).resolves.toBeNull();
      expect(fs.readdirSync(stateDir).sort()).toEqual(before);
    });

    it('is null when builder.pid names a live pid and no server is running: builder.pid alone proves nothing', async () => {
      const stateDir = path.join(workspace, 'state-live');
      fs.mkdirSync(stateDir);
      fs.writeFileSync(
        path.join(stateDir, 'builder.pid'),
        JSON.stringify({ pid: process.pid, serverPid: process.pid, startedAt: new Date().toISOString() }) + '\n',
      );
      vi.stubEnv('CODEGRAPH_STATE_DIR', stateDir);
      const builderRoute = await loadBuilderRoute();
      const before = fs.readdirSync(stateDir).sort();

      await expect(builderRoute()).resolves.toBeNull();
      expect(fs.readdirSync(stateDir).sort()).toEqual(before);
    });
  });

  // ---- U9: the release fence, and drain ----
  // A `fence` carries `kind`: 'index' (the default, the lease of `codegraph index`) or 'release' (the lease of `uninit`).
  // On a release-fenced root, the CLI's sync and reindex jobs refuse when they start. `drain` answers once no job of its
  // root runs or waits. Each case here is a fence or a drain arriving while a job runs, which is the window the
  // refusal and the wait exist for.

  // U9a: a release fence does not stop the sync already running, and the drain of that root answers after the sync.
  it('U9a drain of a root whose sync is running answers after that sync, and a release fence leaves the running sync to finish', async () => {
    // 150 files added after the index: the sync this case waits on is still running when the fence arrives.
    const root = path.join(workspace, 'big');
    await indexedProject(root);
    addFiles(root, 150);
    const r = real(root);
    const svc = startService();
    expect(svc.holders.has(r), 'premise: nothing is held').toBe(false);

    const syncing = ask(svc, { id: 1, op: 'cliSync', root: r });
    expect(await waitUntil(() => jobStarted('sync', r), 20_000, 5), 'premise: the sync job started').toBe(true);
    expect(jobOk('sync', r), 'premise: the sync is still running when the fence arrives').toBe(false);

    await ask(svc, { id: 2, op: 'fence', root: r, kind: 'release' });
    expect(replyTo(2), 'a release fence is taken while the sync runs').toMatchObject({ id: 2, ok: true });
    const draining = ask(svc, { id: 3, op: 'drain', root: r });
    await Promise.all([syncing, draining]);

    expect(replyTo(1), 'the running sync answered its SyncResult').toMatchObject({ id: 1, ok: true, result: { filesAdded: 150 } });
    expect(replyTo(3)?.error ?? null, 'drain answered without an error').toBeNull();
    expect(replyTo(3), 'drain answered ok').toMatchObject({ id: 3, ok: true });
    expect(replyIndex(3), 'drain answered after the sync reply').toBeGreaterThan(replyIndex(1));
  }, 180_000);

  // U9b: a release fence refuses a sync and a reindex that are asked for after it. The refusal is made when the request
  // arrives (the fence stands already), and the work is not done. A job queued before the fence refuses when it starts: U9f.
  it('U9b a release fence refuses a cliSync and a cliIndex reindex asked for after it, with "being removed"', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    const r = real(root);
    const svc = startService();

    await ask(svc, { id: 1, op: 'fence', root: r, kind: 'release' });
    expect(replyTo(1)).toMatchObject({ id: 1, ok: true });

    await ask(svc, { id: 2, op: 'cliSync', root: r });
    await ask(svc, { id: 3, op: 'cliIndex', root: r, mode: 'reindex' });

    expect(replyTo(2), 'cliSync on a release-fenced root').toMatchObject({
      id: 2,
      ok: false,
      error: expect.stringMatching(/being removed/),
    });
    expect(replyTo(3), 'cliIndex reindex on a release-fenced root').toMatchObject({
      id: 3,
      ok: false,
      error: expect.stringMatching(/being removed/),
    });
  });

  // U9c: an index fence is the lease of `codegraph index`, which a sync does not need to be refused by. The sync runs.
  it('U9c an index fence does not refuse a cliSync: the sync runs and answers its SyncResult', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    fs.writeFileSync(path.join(root, 'src', 'added.ts'), 'export function added() { return 3; }\n');
    const r = real(root);
    const svc = startService();

    await ask(svc, { id: 1, op: 'fence', root: r, kind: 'index' });
    expect(replyTo(1)).toMatchObject({ id: 1, ok: true });

    await ask(svc, { id: 2, op: 'cliSync', root: r });
    expect(replyTo(2), 'cliSync under an index fence').toMatchObject({ id: 2, ok: true, result: { filesAdded: 1 } });
  });

  // U9d: drain of a root with no job answers without waiting for anything.
  it('U9d drain of an idle root answers at once', async () => {
    const root = path.join(workspace, 'p');
    await indexedProject(root);
    const r = real(root);
    const svc = startService();

    const began = Date.now();
    await ask(svc, { id: 1, op: 'drain', root: r });
    const took = Date.now() - began;

    expect(replyTo(1)?.error ?? null, 'drain answered without an error').toBeNull();
    expect(replyTo(1), 'drain answered ok').toMatchObject({ id: 1, ok: true });
    expect(took, 'drain answered within 2 s, with nothing to wait for').toBeLessThan(2_000);
  });

  // U9e: drain waits only for its own root. A sync of another root is still running when the drain of this one answers.
  it('U9e drain of an idle root answers while a sync of another root still runs', async () => {
    // 150 files added to one root: its sync is still running when the other root's drain answers.
    const busy = path.join(workspace, 'busy');
    await indexedProject(busy);
    addFiles(busy, 150);
    const rb = real(busy);
    const idle = path.join(workspace, 'idle');
    await indexedProject(idle);
    const ri = real(idle);
    const svc = startService();

    const syncing = ask(svc, { id: 1, op: 'cliSync', root: rb });
    expect(await waitUntil(() => jobStarted('sync', rb), 20_000, 5), 'premise: the sync of the busy root started').toBe(true);
    expect(jobOk('sync', rb), 'premise: the busy root\'s sync is still running').toBe(false);

    await ask(svc, { id: 2, op: 'drain', root: ri });
    expect(replyTo(2)?.error ?? null, 'drain of the idle root answered without an error').toBeNull();
    expect(replyTo(2), 'drain of the idle root answered ok').toMatchObject({ id: 2, ok: true });
    expect(replyTo(1), 'the busy root\'s sync was still running when the idle root\'s drain answered').toBeUndefined();

    await syncing;
    expect(replyTo(1), 'the busy root\'s sync answered ok').toMatchObject({ id: 1, ok: true });
  }, 180_000);

  // U9f: a sync queued before the release fence starts after it, and refuses when it starts. The sync that was already
  // running is not touched by the fence.
  it('U9f a cliSync queued before a release fence refuses when it starts; the sync running when the fence came finishes', async () => {
    // 150 files added and read by the first sync; the queued sync starts only after it.
    const root = path.join(workspace, 'big');
    await indexedProject(root);
    addFiles(root, 150);
    const r = real(root);
    const svc = startService();

    const first = ask(svc, { id: 1, op: 'cliSync', root: r });
    expect(await waitUntil(() => jobStarted('sync', r), 20_000, 5), 'premise: the first sync started').toBe(true);
    expect(jobOk('sync', r), 'premise: the first sync is still running').toBe(false);
    const second = ask(svc, { id: 2, op: 'cliSync', root: r });
    expect(svc.queue.waiting().sync, 'premise: the second sync waits behind the first').toBe(1);

    await ask(svc, { id: 3, op: 'fence', root: r, kind: 'release' });
    expect(replyTo(3), 'the release fence is taken').toMatchObject({ id: 3, ok: true });
    await Promise.all([first, second]);

    expect(replyTo(1), 'the sync that was running finished').toMatchObject({ id: 1, ok: true, result: { filesAdded: 150 } });
    expect(replyTo(2), 'the queued sync refused when it started').toMatchObject({
      id: 2,
      ok: false,
      error: expect.stringMatching(/being removed/),
    });
  }, 180_000);

  // U9g: a seed of worktree W reads its source S. The job is queued under W, so the drain of S must still wait for it,
  // and a seed that has not started must not open S once S is release-fenced.
  describe('U9g a seed that reads a release-fenced root', () => {
    /** S: an indexed repository; W: a linked worktree of it with no index, which `ensure` seeds from S. */
    async function repoWithWorktree(): Promise<{ s: string; w: string }> {
      const s = path.join(workspace, 'main');
      await indexedRepo(s);
      const w = path.join(workspace, 'wt');
      git(s, 'worktree', 'add', '-q', '-b', 'feature', w, 'HEAD');
      return { s: real(s), w: real(w) };
    }

    it('U9g a seed of W queued behind another root\'s job: drain of S answers after the seed settles, and the seed fails "being removed" without opening S', async () => {
      const { s, w } = await repoWithWorktree();
      // T's sync holds the queue (300 files added after its index), so W's seed waits in it.
      const t = path.join(workspace, 'third');
      await indexedProject(t);
      addFiles(t, 300);
      const rt = real(t);
      const svc = startService();

      const syncing = ask(svc, { id: 1, op: 'cliSync', root: rt });
      expect(await waitUntil(() => jobStarted('sync', rt), 20_000, 5), 'premise: the third root\'s sync started').toBe(true);
      const ensuring = svc.ensure(w);
      expect(await waitUntil(() => svc.queue.waiting().sync === 1, 20_000, 5), 'premise: the seed of W waits behind the sync').toBe(true);
      expect(jobOk('sync', rt), 'premise: the sync is still running').toBe(false);
      expect(jobStarted('seed', w), 'premise: the seed has not started').toBe(false);

      await ask(svc, { id: 2, op: 'fence', root: s, kind: 'release' });
      expect(replyTo(2), 'the release fence on S is taken').toMatchObject({ id: 2, ok: true });
      await ask(svc, { id: 3, op: 'drain', root: s });
      const seedSettled = jobLines.some((l) => l.includes(` job end seed ${w} `));
      const seedFailure = jobLines.find((l) => l.includes(` job end seed ${w} failed`)) ?? '';
      await Promise.all([syncing, ensuring]);

      expect(replyTo(3), 'drain answered ok').toMatchObject({ id: 3, ok: true });
      expect(seedSettled, 'the seed of W had ended when the drain of S answered').toBe(true);
      expect(seedFailure, 'the seed failed because S is being removed').toMatch(/being removed/);
      expect(fs.existsSync(path.join(w, '.codegraph', 'codegraph.db')), 'W got no index: the seed never opened S').toBe(false);
    }, 180_000);

    it('U9g a seed of W already running when S is fenced: drain of S answers after the seed ended', async () => {
      const { s, w } = await repoWithWorktree();
      const svc = startService();

      const ensuring = svc.ensure(w);
      expect(await waitUntil(() => jobStarted('seed', w), 20_000, 2), 'premise: the seed of W started').toBe(true);

      await ask(svc, { id: 1, op: 'fence', root: s, kind: 'release' });
      expect(replyTo(1), 'the release fence on S is taken').toMatchObject({ id: 1, ok: true });
      await ask(svc, { id: 2, op: 'drain', root: s });
      const seedSettled = jobLines.some((l) => l.includes(` job end seed ${w} `));
      await ensuring;

      expect(replyTo(2), 'drain answered ok').toMatchObject({ id: 2, ok: true });
      expect(seedSettled, 'the seed of W had ended when the drain of S answered').toBe(true);
    }, 180_000);
  });
});
