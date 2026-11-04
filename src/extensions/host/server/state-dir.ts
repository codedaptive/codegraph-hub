/**
 * Where CodeGraph keeps its machine-wide state: the one machine server's
 * socket, lock and log (`server.sock`, `server.pid`, `server.log`,
 * src/mcp/daemon-paths.ts) and the worktree-lifecycle project registry
 * (`projects/`, src/extensions/host/worktree-lifecycle/project-registry.ts).
 *
 * `CODEGRAPH_STATE_DIR` moves all of it. A development build or a test sets it
 * and so runs its own server beside the live one: two state dirs never share a
 * socket, a lock or a registry record, so neither can see, join or stop the
 * other's server. Unset or empty, the state dir is `~/.codegraph`.
 *
 * The value must be an absolute path. A relative one is invalid, never
 * resolved: resolved against each process's working directory, one setting
 * would name a different state dir (and so a different server) in every
 * worktree. {@link getStateDir} throws {@link InvalidStateDirError} for it: a
 * command that needs the state dir fails with that message; `serve --mcp` logs
 * it and serves a direct session. It never falls back to `~/.codegraph`.
 *
 * One physical state dir has one identity. The path ({@link getStateDir}) is
 * canonicalised through its longest existing ancestor (`realpath`, so `/var` and
 * `/private/var` on macOS, or a symlinked `CODEGRAPH_STATE_DIR`, name the same
 * state dir), but a path is only a spelling and `realpath` cannot unify every
 * one: on macOS `/Users/...` and `/System/Volumes/Data/Users/...` are one
 * directory (a firmlink) that `realpath` keeps apart, and a bind mount does the
 * same. What the server's lock, its tmpdir socket and its Windows pipe are keyed
 * on is therefore {@link getStateDirIdentity}, the identity of the directory
 * itself: `dev:ino` (POSIX) or the lower-cased native realpath (Windows). The
 * path stays the display spelling (`server.pid`'s `stateDir`, `codegraph daemon`
 * output). Were the lock judged by spelling, two launchers reaching one state dir
 * by two spellings would each call the other's live lock a copied state dir's
 * record, delete it and take over the shared socket.
 *
 * Read on every call, never cached: tests and the CLI set the variable per
 * process, and the detached server inherits it from the launcher that spawned
 * it. {@link getStateDir} creates nothing; {@link ensureStateDir} creates the
 * directory private to the user (mode 0700), because the server's lock names
 * its pid and its socket accepts every request a client sends.
 *
 * Node built-ins and src/directory.ts (for `statInode`) only: the CLI, the
 * server and the extension registration all load this module.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { statInode } from '../../../directory';

/** `CODEGRAPH_STATE_DIR` is set to something other than an absolute path. */
export class InvalidStateDirError extends Error {
  constructor(value: string) {
    super(
      `CODEGRAPH_STATE_DIR must be an absolute path (it is ${JSON.stringify(value)}); ` +
      'set it to an absolute path, or unset it to use ~/.codegraph.'
    );
    this.name = 'InvalidStateDirError';
  }
}

/**
 * Canonical spelling of the absolute path `abs`: the real path of its longest
 * existing ancestor with the not-yet-existing remainder appended, so the
 * spelling is the same before and after the directory is created. A path that
 * cannot be resolved for any other reason (permissions, a symlink loop) stays
 * as given: it cannot be used as a state dir either, and the caller's own
 * mkdir or connect reports why.
 */
function canonicalPath(abs: string): string {
  let head = abs;
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...missing.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return abs;
    }
    const parent = path.dirname(head);
    if (parent === head) return abs;
    missing.push(path.basename(head));
    head = parent;
  }
}

/**
 * `CODEGRAPH_STATE_DIR` when set and non-empty (it must be absolute, else this
 * throws {@link InvalidStateDirError}); otherwise `~/.codegraph`. Normalised
 * and canonicalised (a trailing separator, a `..` segment or a symlink does not
 * make a second path), the spelling shown to people and written in the lock's
 * `stateDir`. Not an identity: a firmlink or bind mount gives one directory two
 * canonical paths, so compare and hash {@link getStateDirIdentity}. Creates
 * nothing.
 */
export function getStateDir(): string {
  const raw = process.env.CODEGRAPH_STATE_DIR;
  if (raw === undefined || raw === '') return canonicalPath(path.join(os.homedir(), '.codegraph'));
  if (!path.isAbsolute(raw)) throw new InvalidStateDirError(raw);
  return canonicalPath(path.resolve(raw)); // absolute already: normalised, never cwd-relative
}

/**
 * Create the state dir (and any missing parents) with mode 0o700 and return
 * its canonical path. `mkdir`'s mode applies only to directories it creates, and
 * the umask can only narrow it: an existing state dir keeps the mode its owner
 * gave it. The path is read again after the mkdir; it is the same string
 * {@link getStateDir} gave before it, because only the existing ancestor is
 * resolved.
 */
export function ensureStateDir(): string {
  fs.mkdirSync(getStateDir(), { recursive: true, mode: 0o700 });
  return getStateDir();
}

/**
 * Identity of the state dir as it is now, the key that tells one physical state
 * dir from another whatever the spelling of its path: `dev:ino` of the directory
 * ({@link statInode}) on POSIX, the lower-cased native realpath on Windows (the
 * same rule as `canonicalProjectRoot`: Windows has no usable inode, and NTFS
 * cannot hold two directories that differ only by case). Null while the state
 * dir does not exist: it has no identity yet, so nothing can be serving it. A
 * caller that creates or serves from the directory calls {@link ensureStateDir}
 * first; one that only looks answers "no server" for null.
 *
 * What it distinguishes: on POSIX, directories (a state dir copied with cp -r
 * or rsync has its own `dev:ino`, so a lock record naming the source is foreign;
 * a state dir deleted and recreated normally gets a new one, but `dev:ino` has no
 * generation, so a filesystem that reuses the inode keeps the identity); on
 * Windows, only paths, so recreating the dir at the same path keeps its identity.
 * It is not proof of who is serving: inode reuse, or a cloned disk image that
 * keeps `dev:ino`, can make an old lock read as this state dir's own. Liveness
 * (the pid) and the socket hello still decide whether a server is there. Throws {@link InvalidStateDirError} like {@link getStateDir}.
 */
export function getStateDirIdentity(): string | null {
  const dir = getStateDir();
  if (process.platform === 'win32') {
    try {
      return fs.realpathSync.native(dir).toLowerCase();
    } catch {
      return null;
    }
  }
  return statInode(dir);
}
