/**
 * The bind failure when no socket candidate binds.
 *
 * There is no length filter on the tmpdir candidate. On macOS (measured; see Group C), a 100-byte filter
 * would drop a working tmpdir candidate for every TMPDIR over 61 bytes; the state-dir candidate keeps its
 * 100-byte skip. What this file pins is what
 * the user sees when EVERY candidate fails: one SocketBindError naming each attempt's path, its length in
 * bytes and its error code; then each skipped candidate; then, only when some attempt failed with a length
 * error (EINVAL or ENAMETOOLONG), a line telling the user to shorten TMPDIR or the state dir.
 *
 * Lengths are bytes (Buffer.byteLength), not characters: an accented letter is two bytes in UTF-8.
 *
 * Measured on macOS (Node v26.12.0, Darwin 27.2.0): absolute AF_UNIX paths of 100 to 253 bytes bind and
 * connect; 254 and more fail with EINVAL. Linux is not measured here, so no test pins a Linux number.
 *
 * Group A: bindFirstUsableSocket with an injected listen. Group B: the machine server's start path, run as a
 * real process, with a state dir and a TMPDIR over 300 bytes, which Darwin refuses (see Group C). Group C: the macOS measurement above.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { WASM_RUNTIME_FLAGS } from '../../../src/extraction/wasm-runtime-flags';
import { bindFirstUsableSocket, bindServerSocket, SocketBindError } from '../../../src/mcp/daemon';
import { getServerSocketCandidates } from '../../../src/mcp/daemon-paths';
import { BIN, gateEnv } from './machine-server.harness';

const HEADER = 'Could not bind the CodeGraph server socket; every candidate failed:';
const SHORTEN_LINE =
  'A socket path this long may be over this machine\'s limit: shorten TMPDIR or the state dir (CODEGRAPH_STATE_DIR).';
const SKIP_REASON = 'longer than the 100-byte state-dir limit';

/** Bound on the wait for the server process to exit. It bounds a hang; a normal exit is not expected to take this long. */
const EXIT_BOUND_MS = 30_000;

const STATE_CANDIDATE = '/state/codegraph/server.sock';
const TMP_CANDIDATE = '/var/folders/0a/T/codegraph-server-0123456789abcdef.sock';

/** UTF-8 length: what the message reports, and what the kernel's sun_path limit counts. */
const bytes = (p: string): number => Buffer.byteLength(p);

/** One bind attempt's line, as the message spells it. */
const attemptLine = (p: string, code: string): string => `${p} (${bytes(p)} bytes): ${code}`;

/** The members of SocketBindError that this file reads. */
interface BindFailure extends Error {
  code?: string;
  attempts?: Array<{ socketPath: string; bytes: number; code: string }>;
  cause?: unknown;
}

const priorStateDir = process.env.CODEGRAPH_STATE_DIR;
const priorTmpdir = process.env.TMPDIR;
const madeDirs: string[] = [];
const children: ChildProcess[] = [];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const dir of madeDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  restoreEnv('CODEGRAPH_STATE_DIR', priorStateDir);
  restoreEnv('TMPDIR', priorTmpdir);
});

/** Runs `fn` with `vars` set in this process, then puts the prior values back. */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const prior = Object.keys(vars).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [name, value] of prior) restoreEnv(name, value);
  }
}

/**
 * `base` with nested components added until its UTF-8 length is over `minBytes`. Each component is about 70
 * bytes, so no single name comes near the 255-byte NAME_MAX.
 */
function longPath(base: string, minBytes: number): string {
  let p = base;
  for (let i = 0; bytes(p) <= minBytes; i++) p = path.join(p, `segment-${i}-${'n'.repeat(60)}`);
  return p;
}

const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(`listen ${code}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

const fakeServer = (tag: string): net.Server => ({ tag } as unknown as net.Server);

/**
 * A listen that rejects with the given code for each listed path and binds every other path. `errors` keeps
 * the error object it rejected each path with, so a test can check the cause by identity.
 */
function scriptedListen(failures: Record<string, string>) {
  const tried: string[] = [];
  const errors = new Map<string, NodeJS.ErrnoException>();
  const listen = (socketPath: string): Promise<net.Server> => {
    tried.push(socketPath);
    const code = failures[socketPath];
    if (code === undefined) return Promise.resolve(fakeServer(socketPath));
    const err = errno(code);
    errors.set(socketPath, err);
    return Promise.reject(err);
  };
  return { listen, tried, errors };
}

/** The error a bind that must fail rejects with. The test fails if the bind resolves. */
async function bindError(
  candidates: string[],
  listen: (socketPath: string) => Promise<net.Server>,
  opts?: { skipped?: Array<{ socketPath: string; reason: string }> },
): Promise<BindFailure> {
  try {
    await bindFirstUsableSocket(candidates, listen, opts);
  } catch (err) {
    return err as BindFailure;
  }
  throw new Error('bindFirstUsableSocket resolved; the test expected every candidate to fail');
}

/** The rejection must be a SocketBindError. The export is checked first so a missing class is reported as such. */
function expectSocketBindError(err: BindFailure): void {
  expect(SocketBindError, 'src/mcp/daemon.ts must export SocketBindError').toBeTypeOf('function');
  expect(err).toBeInstanceOf(SocketBindError);
}

describe('bindFirstUsableSocket when every candidate fails', () => {
  it('names each attempt with its byte length and code, in order, then the shorten line', async () => {
    const failing = scriptedListen({ [STATE_CANDIDATE]: 'ENOTSUP', [TMP_CANDIDATE]: 'EINVAL' });
    const err = await bindError([STATE_CANDIDATE, TMP_CANDIDATE], failing.listen);
    expect(err.message).toContain(HEADER);
    const first = err.message.indexOf(attemptLine(STATE_CANDIDATE, 'ENOTSUP'));
    const last = err.message.indexOf(attemptLine(TMP_CANDIDATE, 'EINVAL'));
    expect(first, 'the first attempt line').toBeGreaterThan(-1);
    expect(last, 'the last attempt line comes after the first').toBeGreaterThan(first);
    expect(err.message.indexOf(SHORTEN_LINE), 'the shorten line comes after the attempts').toBeGreaterThan(last);
    expect(err.attempts).toEqual([
      { socketPath: STATE_CANDIDATE, bytes: bytes(STATE_CANDIDATE), code: 'ENOTSUP' },
      { socketPath: TMP_CANDIDATE, bytes: bytes(TMP_CANDIDATE), code: 'EINVAL' },
    ]);
  });

  it('leaves out the shorten line when no attempt failed with a length error', async () => {
    const failing = scriptedListen({ [STATE_CANDIDATE]: 'ENOTSUP', [TMP_CANDIDATE]: 'ENOTSUP' });
    const err = await bindError([STATE_CANDIDATE, TMP_CANDIDATE], failing.listen);
    expect(err.message).toContain(HEADER);
    expect(err.message).toContain(attemptLine(STATE_CANDIDATE, 'ENOTSUP'));
    expect(err.message).toContain(attemptLine(TMP_CANDIDATE, 'ENOTSUP'));
    expect(err.message).not.toContain('shorten TMPDIR');
    expect(err.code).toBe('ENOTSUP');
  });

  it('adds the shorten line for ENAMETOOLONG', async () => {
    const failing = scriptedListen({ [STATE_CANDIDATE]: 'ENOTSUP', [TMP_CANDIDATE]: 'ENAMETOOLONG' });
    const err = await bindError([STATE_CANDIDATE, TMP_CANDIDATE], failing.listen);
    expect(err.message).toContain(attemptLine(TMP_CANDIDATE, 'ENAMETOOLONG'));
    expect(err.message).toContain(SHORTEN_LINE);
    expect(err.code).toBe('ENAMETOOLONG');
  });

  it('adds the shorten line when a length error came from an earlier attempt, not the last', async () => {
    const failing = scriptedListen({ [STATE_CANDIDATE]: 'EINVAL', [TMP_CANDIDATE]: 'ENOTSUP' });
    const err = await bindError([STATE_CANDIDATE, TMP_CANDIDATE], failing.listen);
    expect(err.message).toContain(attemptLine(STATE_CANDIDATE, 'EINVAL'));
    expect(err.message).toContain(attemptLine(TMP_CANDIDATE, 'ENOTSUP'));
    expect(err.message).toContain(SHORTEN_LINE);
    expect(err.code).toBe('ENOTSUP');
  });

  it('lists a skipped candidate after the attempts, with its byte length and reason', async () => {
    const skipped = `/state/${'x'.repeat(120)}/server.sock`;
    const failing = scriptedListen({ [TMP_CANDIDATE]: 'ENOTSUP' });
    const err = await bindError([TMP_CANDIDATE], failing.listen, {
      skipped: [{ socketPath: skipped, reason: SKIP_REASON }],
    });
    expect(err.message).toContain(HEADER);
    const skipLine = `${skipped} (${bytes(skipped)} bytes): skipped, ${SKIP_REASON}`;
    expect(err.message).toContain(skipLine);
    expect(err.message.indexOf(skipLine)).toBeGreaterThan(
      err.message.indexOf(attemptLine(TMP_CANDIDATE, 'ENOTSUP')),
    );
    expect(err.message).not.toContain('shorten TMPDIR');
  });

  it('counts bytes, not characters: a non-ASCII path reports its UTF-8 length', async () => {
    const accented = '/state/café/codegraph-server-0123456789abcdef.sock';
    expect(bytes(accented), 'the premise: the accented letter is two bytes').toBeGreaterThan(accented.length);
    const failing = scriptedListen({ [accented]: 'ENOTSUP', [TMP_CANDIDATE]: 'EINVAL' });
    const err = await bindError([accented, TMP_CANDIDATE], failing.listen);
    expect(err.message).toContain(HEADER);
    expect(err.message).toContain(attemptLine(accented, 'ENOTSUP'));
    expect(err.message).not.toContain(`${accented} (${accented.length} bytes)`);
    expect(err.attempts?.[0]?.bytes).toBe(bytes(accented));
  });

  it('rejects with a SocketBindError whose code and cause are the last attempt\'s', async () => {
    const failing = scriptedListen({ [STATE_CANDIDATE]: 'ENOTSUP', [TMP_CANDIDATE]: 'EINVAL' });
    const err = await bindError([STATE_CANDIDATE, TMP_CANDIDATE], failing.listen);
    expectSocketBindError(err);
    expect(err.code).toBe('EINVAL');
    expect(err.cause).toBe(failing.errors.get(TMP_CANDIDATE));
  });

  it('rejects with a SocketBindError saying there are no socket candidates when the list is empty', async () => {
    const failing = scriptedListen({});
    const err = await bindError([], failing.listen);
    expectSocketBindError(err);
    expect(err.message).toMatch(/no socket candidates/);
    // No attempt was made, so there is no error to carry: the code is ENOENT and `cause` is not set at all.
    expect(err.code).toBe('ENOENT');
    expect(err.cause).toBeUndefined();
    expect('cause' in err, 'no cause property when no attempt failed').toBe(false);
    expect(failing.tried).toEqual([]);
  });
});

describe('the state-dir socket skip', () => {
  // The skip counts UTF-8 bytes, which is what the kernel counts, not String.length. The state dir below is named with
  // 'é' (two bytes, one UTF-16 unit), sized so that `<state>/server.sock` is exactly 100 characters and 100 + N bytes,
  // where N is the number of 'é' (about 60 under /private/tmp on macOS; the test computes it). The old
  // `inState.length > 100` comparison saw 100, not over the limit, and listed the state-dir socket; the byte
  // comparison sees over 100 and skips it. So this fails against the character count and passes against the byte count.
  it.runIf(process.platform !== 'win32')(
    'skips a state-dir socket that is 100 characters or less but over 100 bytes',
    () => {
      const root = fs.mkdtempSync('/tmp/cg-sock-utf8-');
      madeDirs.push(root);
      const realRoot = fs.realpathSync(root);
      // `<realRoot>/<n x é>/server.sock`: the fixed part is realRoot + '/' + '/server.sock'.
      const fixed = realRoot.length + 1 + '/server.sock'.length;
      const accents = 100 - fixed;
      expect(accents, 'the premise: room for at least one accent under /tmp').toBeGreaterThan(0);
      const stateSpelled = path.join(realRoot, 'é'.repeat(accents));
      fs.mkdirSync(stateSpelled, { recursive: true });
      const stateDir = fs.realpathSync(stateSpelled);
      const stateSocket = path.join(stateDir, 'server.sock');
      expect(stateSocket.length, 'the premise: 100 characters, so not over the limit by character count').toBe(100);
      expect(bytes(stateSocket), 'the premise: over 100 bytes').toBeGreaterThan(100);

      const candidates = withEnv(
        { CODEGRAPH_STATE_DIR: stateDir, TMPDIR: root },
        () => getServerSocketCandidates(),
      );
      expect(candidates).not.toContain(stateSocket);
      expect(candidates).toHaveLength(1);
      expect(path.basename(candidates[0]!)).toMatch(/^codegraph-server-[0-9a-f]{16}\.sock$/);
    },
  );
});

describe('the machine server start path when no socket candidate binds', () => {
  // Windows is excluded: its one candidate is a named pipe, and there is no state-dir skip to report.
  // The paths here are over 300 bytes. Darwin refuses 254 bytes and up (measured); the test assumes other POSIX
  // systems refuse a path this long too (not measured).
  // This test can take more than 5 s: the child is a cold node process that loads the whole built CLI before it
  // reaches the bind. EXIT_BOUND_MS bounds a hang, not the expected time.
  it.runIf(process.platform !== 'win32')(
    'exits 1 and names each attempt, the skipped state-dir socket and the shorten line, with lengths',
    async () => {
      const root = fs.mkdtempSync('/tmp/cg-sock-long-');
      madeDirs.push(root);
      const stateSpelled = longPath(path.join(root, 'state'), 260);
      const tmpSpelled = longPath(path.join(root, 'tmp'), 260);
      fs.mkdirSync(stateSpelled, { recursive: true });
      fs.mkdirSync(tmpSpelled, { recursive: true });
      // The server names its state dir by the canonical path, so the expected lines use the real one.
      const stateDir = fs.realpathSync(stateSpelled);

      // The candidates the server will walk, read here with the same state dir and TMPDIR. The state-dir socket
      // is over POSIX_SOCKET_PATH_LIMIT (100), so the tmpdir socket is the only candidate.
      const candidates = withEnv(
        { CODEGRAPH_STATE_DIR: stateDir, TMPDIR: tmpSpelled },
        () => getServerSocketCandidates(),
      );
      expect(candidates).toHaveLength(1);
      const tmpSocket = candidates[0]!;
      const stateSocket = path.join(stateDir, 'server.sock');

      const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--mcp'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: gateEnv(stateDir, { TMPDIR: tmpSpelled, CODEGRAPH_DAEMON_INTERNAL: '1' }),
      });
      children.push(child);
      let stderr = '';
      child.stdout?.resume();
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
      // Attached before the first await, so an exit that comes early is not missed.
      const closed = once(child, 'close').then(([code, signal]) => ({ code, signal }));
      let timer: NodeJS.Timeout | undefined;
      const hang = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), EXIT_BOUND_MS); });
      const exit = await Promise.race([closed, hang]);
      clearTimeout(timer);
      if (exit === null) child.kill('SIGKILL');
      expect(exit, 'the server must exit once every bind has failed, not hang').not.toBeNull();

      const out = stripAnsi(stderr);
      expect(out).toContain(HEADER);
      const attempt = out.split('\n').find((line) => line.includes(`${tmpSocket} (${bytes(tmpSocket)} bytes): `));
      expect(attempt, `the message must name the tmpdir socket ${tmpSocket}`).toBeDefined();
      expect(attempt).toMatch(/: (EINVAL|ENAMETOOLONG)\s*$/);
      const skipLine = `${stateSocket} (${bytes(stateSocket)} bytes): skipped, ${SKIP_REASON}`;
      expect(out).toContain(skipLine);
      expect(out.indexOf(attempt!), 'the attempt line comes before the skipped line').toBeLessThan(out.indexOf(skipLine));
      expect(out).toContain(SHORTEN_LINE);
      expect(fs.existsSync(path.join(stateDir, 'server.pid')), 'the lockfile is released').toBe(false);
      expect(exit!.code).toBe(1);
    },
    45_000,
  );
});

describe('the tmpdir socket on macOS', () => {
  // Records the macOS measurement behind keeping no length filter on the tmpdir candidate: Node v26.12.0 on Darwin
  // 27.2.0 binds and connects absolute AF_UNIX paths of 100 to 253 bytes, and fails 254 and more with EINVAL.
  // Darwin only: Linux is not measured. It fails if a length filter drops a tmpdir socket that would bind (any
  // TMPDIR over 61 bytes gives a candidate over 100 bytes).
  it.runIf(process.platform === 'darwin')(
    'keeps a 100-to-253-byte tmpdir socket in the candidate list, and it binds and accepts a connection',
    async () => {
      const root = fs.mkdtempSync('/tmp/cg-sock-mid-');
      madeDirs.push(root);
      // The candidate is TMPDIR + '/codegraph-server-' + 16 hex digits + '.sock', 39 bytes beyond TMPDIR.
      // A 161-byte TMPDIR gives a 200-byte socket path.
      const tmpDir = path.join(root, 'z'.repeat(161 - bytes(root) - 1));
      fs.mkdirSync(tmpDir, { recursive: true });
      const stateSpelled = path.join(root, 'state');
      fs.mkdirSync(stateSpelled, { recursive: true });
      const stateDir = fs.realpathSync(stateSpelled);

      const candidates = withEnv(
        { CODEGRAPH_STATE_DIR: stateDir, TMPDIR: tmpDir },
        () => getServerSocketCandidates(),
      );
      const tmpSocket = candidates.find((c) => path.basename(c).startsWith('codegraph-server-'));
      expect(tmpSocket, 'the tmpdir socket must stay in the candidate list').toBeDefined();
      expect(path.dirname(tmpSocket!)).toBe(tmpDir);
      expect(bytes(tmpSocket!)).toBeGreaterThanOrEqual(101);
      expect(bytes(tmpSocket!)).toBeLessThanOrEqual(253);

      const server = await bindServerSocket(tmpSocket!, (socket) => socket.destroy());
      try {
        const client = net.createConnection(tmpSocket!);
        try {
          await once(client, 'connect');
        } finally {
          client.destroy();
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
