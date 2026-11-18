import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileWatcher, __setFsWatchForTests } from '../../../src/sync/watcher';

type Listener = (event: string, filename: string | Buffer | null) => void;

describe('FileWatcher symlink root boundary', () => {
  let root: string;
  let outside: string;
  let opened: string[];
  let closed: string[];
  let listeners: Map<string, Listener>;
  let watcher: FileWatcher | undefined;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-watch-link-root-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-watch-link-outside-')));
    expect(() => execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' })).toThrow();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/main.ts'), 'export const main = 1;\n');
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(root, 'state'));
    vi.stubEnv('CODEGRAPH_DIR', '.codegraph');
    vi.stubEnv('CODEGRAPH_NO_WATCH', '');
    opened = [];
    closed = [];
    listeners = new Map();
    __setFsWatchForTests(((dir: fs.PathLike, _options: unknown, listener: Listener) => {
      const watched = String(dir);
      const stream = new EventEmitter() as fs.FSWatcher;
      opened.push(watched);
      listeners.set(watched, listener);
      stream.close = () => { closed.push(watched); };
      return stream;
    }) as unknown as typeof fs.watch);
  });

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
    __setFsWatchForTests(null);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  function startWatcher(): void {
    watcher = new FileWatcher(root, async () => ({ filesChanged: 0, durationMs: 0 }), { debounceMs: 100 });
    expect(watcher.start()).toBe(true);
  }

  function watched(link: string, paths = opened): boolean {
    return paths.some(dir => dir === link || dir.startsWith(link + path.sep));
  }

  // Junctions exercise Windows directory links without requiring symlink privileges (as watcher.test.ts does).
  function linkDir(target: string, name: string): void {
    fs.symlinkSync(target, name, process.platform === 'win32' ? 'junction' : 'dir');
  }

  it('does not watch a link to an outside directory', () => {
    fs.mkdirSync(path.join(root, 'data'));
    const link = path.join(root, 'data/runs');
    linkDir(outside, link);

    startWatcher();
    expect(watched(link)).toBe(false);
  });

  it('watches only the re-included link to an outside directory', () => {
    fs.writeFileSync(path.join(root, '.codegraphignore'), '!data/runs\n');
    fs.mkdirSync(path.join(root, 'data'));
    fs.mkdirSync(path.join(outside, 'runs'));
    fs.mkdirSync(path.join(outside, 'other'));
    const runs = path.join(root, 'data/runs');
    const other = path.join(root, 'data/other');
    linkDir(path.join(outside, 'runs'), runs);
    linkDir(path.join(outside, 'other'), other);

    startWatcher();
    expect(watched(runs)).toBe(true);
    expect(watched(other)).toBe(false);
  });

  it('watches a link to a directory inside the root', () => {
    fs.mkdirSync(path.join(root, 'vendor-real'));
    const link = path.join(root, 'lib');
    linkDir(path.join(root, 'vendor-real'), link);

    startWatcher();
    expect(watched(link)).toBe(true);
  });

  it('closes and does not reopen a link when its re-inclusion is removed', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fs.writeFileSync(path.join(root, '.codegraphignore'), '!data/runs\n');
    fs.mkdirSync(path.join(root, 'data'));
    const link = path.join(root, 'data/runs');
    linkDir(outside, link);

    startWatcher();
    expect(watched(link)).toBe(true);
    const beforeChange = opened.length;
    fs.writeFileSync(path.join(root, '.codegraphignore'), '');
    const listener = listeners.get(root);
    expect(listener).toBeDefined();
    listener?.('change', '.codegraphignore');
    vi.advanceTimersByTime(50);

    expect(closed).toContain(link);
    expect(watched(link, opened.slice(beforeChange))).toBe(false);
  });

  // macOS and Linux ignore the junction type; on Windows its dirent isSymbolicLink(), so the same gate applies.
  it.runIf(process.platform === 'win32')('gates an outside junction unless re-included', () => {
    fs.mkdirSync(path.join(root, 'data'));
    const link = path.join(root, 'data/runs');
    fs.symlinkSync(outside, link, 'junction');

    startWatcher();
    expect(watched(link)).toBe(false);
    watcher?.stop();
    opened = [];
    fs.writeFileSync(path.join(root, '.codegraphignore'), '!data/runs\n');
    startWatcher();
    expect(watched(link)).toBe(true);
  });
});
