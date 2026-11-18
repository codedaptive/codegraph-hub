/**
 * A cold build is admitted again when its job starts (seed.ts `admitColdBuild`, run by
 * src/extensions/host/builder/seed-host.ts).
 *
 * A queued cold build writes `.codegraph/` into whatever its root path names at the moment the job starts,
 * which can be minutes after the call that queued it (a running cold build is never preempted). The root of a
 * worktree's build can change, so a path swapped for a link to another
 * directory while the job waits must not make the job build there: the job fails, builds nothing, and says why
 * in the job log. Each case holds the queue still with a blocker job, queues a build behind it, changes the
 * tree, releases the blocker and reads what the job did. The suite's throwaway HOME stands in for the home
 * directory an attacker would aim at (Perkins' probe: the job built `<home>/.codegraph` and indexed a home file).
 *
 * Real SQLite, real files and real git in mkdtemp dirs.
 */
import { inProcessJobRunner } from './helpers/in-process-job-runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuilderService } from '../../../src/extensions/host/builder/service';

function real(p: string): string {
  return fs.realpathSync(path.resolve(p));
}

async function waitUntil(check: () => boolean, timeoutMs: number, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return check();
}

describe('a queued cold build is admitted again when its job starts', { timeout: 60_000 }, () => {
  let workspace: string;
  let home: string;
  let service: BuilderService;
  let jobLines: string[];
  let releaseBlocker: () => void;

  beforeEach(() => {
    workspace = real(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cg-cold-recheck-')));
    home = path.join(workspace, 'home');
    fs.mkdirSync(path.join(home, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(home, 'secret.ts'), 'export function homeSymbol() { return 1; }\n');
    // os.homedir() reads HOME (USERPROFILE on Windows): the unsafe-root check sees this directory as home.
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    jobLines = [];
    releaseBlocker = () => {};
    service = new BuilderService({ runJob: inProcessJobRunner().runJob,
      send: () => { /* the pushes are not under test */ },
      jobLog: (line) => { jobLines.push(line); },
      log: () => { /* diagnostics are not under test */ },
      watchOptions: () => ({ debounceMs: 100 }),
      timing: { pollMs: 25, ownRetryMs: 50, recoverWaitMs: 1_000, seedWaitMs: 200 },
      housekeeping: false,
    });
  });

  afterEach(async () => {
    releaseBlocker();
    await service.stop(0);
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 30_000);

  /** A directory with a source file and a `sub` directory: a plain project, or a victim, or a git worktree. */
  function project(name: string): string {
    const dir = path.join(workspace, name);
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function f() { return 1; }\n');
    return dir;
  }

  /** Hold each build root until the returned function releases the blocker. */
  function holdQueue(...roots: string[]): () => void {
    const gate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    void service.queue.enqueue('sync', '/blocker', () => gate, { alsoRoots: roots });
    return releaseBlocker;
  }

  const jobEnd = (root: string): string | undefined => jobLines.find((l) => l.includes(` job end cold-build ${root} `));
  const dbOf = (dir: string): string => path.join(dir, '.codegraph', 'codegraph.db');

  it('a worktree build whose root was swapped for a link while it waited builds nothing at either target', async () => {
    const a2 = project('A2');
    const a3 = project('A3');
    execFileSync('git', ['init', '-q'], { cwd: a2, stdio: 'ignore' });
    execFileSync('git', ['init', '-q'], { cwd: a3, stdio: 'ignore' });
    const victim = project('victim');
    const release = holdQueue(a2, a3);
    // Both builds queue behind the blocker.
    expect(await service.ensure(path.join(a2, 'sub'))).toEqual({ kind: 'building', root: real(a2) });
    expect(await service.ensure(path.join(a3, 'sub'))).toEqual({ kind: 'building', root: real(a3) });

    // While they wait, each root becomes a link: A2 to the home directory (the unsafe root `ensure` refuses),
    // A3 to a folder that is no unsafe root, so only the realpath comparison can stop it.
    fs.renameSync(a2, `${a2}.orig`);
    fs.symlinkSync(home, a2);
    fs.renameSync(a3, `${a3}.orig`);
    fs.symlinkSync(victim, a3);
    release();
    expect(await waitUntil(() => jobEnd(a2) !== undefined && jobEnd(a3) !== undefined, 20_000), jobLines.join('\n')).toBe(true);

    expect(fs.existsSync(path.join(home, '.codegraph')), 'the home directory was not built').toBe(false);
    expect(fs.existsSync(path.join(victim, '.codegraph')), 'the folder the link names was not built').toBe(false);
    for (const dir of [`${a2}.orig`, `${a3}.orig`]) {
      expect(fs.existsSync(path.join(dir, '.codegraph')), `${dir}/.codegraph`).toBe(false);
    }
    for (const root of [a2, a3]) {
      expect(jobEnd(root), `job of ${root}`).toMatch(/failed: .*not started: .* now resolves to /);
    }
    // The new target has no worktree, so a later call does not queue another build.
    expect(await service.ensure(path.join(a2, 'sub'))).toEqual({ kind: 'none' });
  });

  it('a git worktree build whose directory was swapped for a link while it waited builds nothing there', async () => {
    const wt = project('wt');
    execFileSync('git', ['init', '-q'], { cwd: wt, stdio: 'ignore' });
    const victim = project('victim');
    const release = holdQueue(wt);
    // No sibling worktree to copy from: the build is queued, at the worktree root.
    expect(await service.ensure(path.join(wt, 'sub'))).toEqual({ kind: 'building', root: real(wt) });

    fs.renameSync(wt, `${wt}.orig`);
    fs.symlinkSync(victim, wt);
    release();
    expect(await waitUntil(() => jobEnd(wt) !== undefined, 20_000), jobLines.join('\n')).toBe(true);

    expect(fs.existsSync(path.join(victim, '.codegraph')), 'the folder the link names was not built').toBe(false);
    expect(fs.existsSync(path.join(`${wt}.orig`, '.codegraph'))).toBe(false);
    expect(jobEnd(wt)).toMatch(/failed: .*not started: .* now resolves to /);
  });

  it('a worktree that loses its git root while queued is refused before the build starts', async () => {
    const root = project('repo');
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    const release = holdQueue(root);
    expect(await service.ensure(path.join(root, 'sub'))).toEqual({ kind: 'building', root: real(root) });

    fs.renameSync(path.join(root, '.git'), path.join(workspace, 'removed-git'));
    release();
    expect(await waitUntil(() => jobEnd(root) !== undefined, 20_000), jobLines.join('\n')).toBe(true);

    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
    expect(jobEnd(root)).toMatch(/failed: .*not started: .*is not a git worktree root/);
  });

  it('a build whose root is unchanged still runs after the admission: the index is built', async () => {
    const anchor = project('repo');
    execFileSync('git', ['init', '-q'], { cwd: anchor, stdio: 'ignore' });
    const release = holdQueue(anchor);
    expect(await service.ensure(path.join(anchor, 'sub'))).toEqual({ kind: 'building', root: real(anchor) });
    release();
    expect(await waitUntil(() => jobEnd(anchor) !== undefined, 30_000), jobLines.join('\n')).toBe(true);

    expect(jobEnd(anchor)).toMatch(/ ok$/);
    expect(fs.existsSync(dbOf(anchor))).toBe(true);
  });
});
