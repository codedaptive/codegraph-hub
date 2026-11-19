/**
 * The machine server proves it runs as this user before a proxy sends it a
 * session.
 *
 * A proxy sends its session's tool calls to whoever listens where the server
 * does, and puts the answers in front of the agent. On Windows the server's
 * named pipe lives in a namespace every user can create in, and on macOS and
 * Linux one socket candidate sits in the temp folder, shared on Linux; Node can
 * read neither a pipe's owner nor a socket peer's user. So the proxy sends a
 * fresh challenge before its client hello, and only a server holding this user's
 * key, which only this user can read, answers it with the right HMAC. The
 * proxy's side is in proxy-connect.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { Daemon, parseClientHelloLine } from '../src/mcp/daemon';
import {
  daemonKey,
  daemonKeyPath,
  daemonProof,
  daemonProofMatches,
  newDaemonChallenge,
  readDaemonKey,
} from '../src/mcp/daemon-proof';

const posix = process.platform !== 'win32';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) {
    try { await cleanups.pop()!(); } catch { /* best-effort */ }
  }
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('the daemon key', () => {
  it('lives in this user\'s ~/.codegraph', () => {
    expect(daemonKeyPath()).toBe(path.join(os.homedir(), '.codegraph', 'daemon.key'));
  });

  it('is made on first use, private, and the same key every time after', () => {
    const file = path.join(tempDir('cg-key-'), 'nested', 'daemon.key');
    expect(readDaemonKey(file)).toBeNull();

    const key = daemonKey(file);
    expect(key).not.toBeNull();
    expect(key!.length).toBeGreaterThanOrEqual(32);
    expect(daemonKey(file)!.equals(key!)).toBe(true);
    expect(readDaemonKey(file)!.equals(key!)).toBe(true);
    if (posix) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // Nothing of the making is left behind.
    expect(fs.readdirSync(path.dirname(file))).toEqual(['daemon.key']);
  });

  it.runIf(posix)('is not used while others can read it, and the daemon replaces it with a private one', () => {
    const file = path.join(tempDir('cg-key-'), 'daemon.key');
    const leaked = daemonKey(file)!;
    fs.chmodSync(file, 0o644);

    expect(readDaemonKey(file)).toBeNull();
    const fresh = daemonKey(file)!;
    expect(fresh.equals(leaked)).toBe(false);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readDaemonKey(file)!.equals(fresh)).toBe(true);
  });

  it.runIf(posix)('is refused, and left alone, when another user owns it', () => {
    const file = path.join(tempDir('cg-key-'), 'daemon.key');
    const theirs = daemonKey(file)!;
    const mine = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(mine + 1);

    expect(readDaemonKey(file)).toBeNull();
    expect(daemonKey(file)).toBeNull();
    vi.restoreAllMocks();
    expect(readDaemonKey(file)!.equals(theirs)).toBe(true);
  });

  it.runIf(posix)('is never read through a link', () => {
    const dir = tempDir('cg-key-');
    const real = path.join(dir, 'real.key');
    daemonKey(real);
    const link = path.join(dir, 'daemon.key');
    fs.symlinkSync(real, link);

    expect(readDaemonKey(link)).toBeNull();
    expect(daemonKey(link)).toBeNull();
  });

  it('is replaced when the file is too short to be a key', () => {
    const file = path.join(tempDir('cg-key-'), 'daemon.key');
    fs.writeFileSync(file, 'short', { mode: 0o600 });

    expect(readDaemonKey(file)).toBeNull();
    const key = daemonKey(file)!;
    expect(key.length).toBeGreaterThanOrEqual(32);
  });
});

describe('a daemon proof', () => {
  const key = randomBytes(32);
  const challenge = newDaemonChallenge();
  const where = '/state/server.sock';

  it('matches only its own key, challenge and path', () => {
    const proof = daemonProof(key, challenge, where);
    expect(daemonProofMatches(key, challenge, where, proof)).toBe(true);
    expect(daemonProofMatches(randomBytes(32), challenge, where, proof)).toBe(false);
    expect(daemonProofMatches(key, newDaemonChallenge(), where, proof)).toBe(false);
    expect(daemonProofMatches(key, challenge, '/tmp/codegraph-x.sock', proof)).toBe(false);
  });

  it('rejects anything that is not a proof', () => {
    for (const bad of [undefined, null, 42, '', 'zz', 'a'.repeat(64), daemonProof(key, challenge, where).toUpperCase(), daemonProof(key, challenge, where) + '0']) {
      expect(daemonProofMatches(key, challenge, where, bad)).toBe(false);
    }
  });

  it('gives a fresh challenge each time', () => {
    expect(newDaemonChallenge()).not.toBe(newDaemonChallenge());
  });

  it('ignores an old challenge field in the client hello', () => {
    const noScope = { pid: 7, hostPid: null, launchDir: null, hasLaunchDir: false, control: false };
    expect(parseClientHelloLine('{"codegraph_client":1,"pid":7,"hostPid":null,"challenge":"abc"}')).toEqual(noScope);
    expect(parseClientHelloLine('{"codegraph_client":1,"pid":7,"hostPid":null}')).toEqual(noScope);
  });

  it('keeps launch directory, focus and tools while ignoring an old challenge', () => {
    const launchDir = path.resolve(os.tmpdir(), 'some project');
    expect(parseClientHelloLine(JSON.stringify({ codegraph_client: 1, pid: 7, hostPid: 8, launchDir, focus: ['src'], tools: '', challenge: 'abc' })))
      .toEqual({ pid: 7, hostPid: 8, launchDir, hasLaunchDir: true, control: false, focus: ['src'], tools: '' });
  });
});

/** A socket or named-pipe path no other test uses. */
function uniqueSocketPath(): string {
  const id = randomBytes(6).toString('hex');
  return posix ? path.join(tempDir('cg-proofsock-'), `d-${id}.sock`) : `\\\\.\\pipe\\codegraph-prooftest-${id}`;
}

/** Read lines off `socket` as they come. */
function lineReader(socket: net.Socket): () => Promise<string> {
  let buffer = '';
  const waiting: Array<(line: string) => void> = [];
  const lines: string[] = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const next = waiting.shift();
      if (next) next(line); else lines.push(line);
    }
  });
  return () => new Promise((resolve, reject) => {
    const line = lines.shift();
    if (line !== undefined) return resolve(line);
    const timer = setTimeout(() => reject(new Error('no line within 5s')), 5_000);
    waiting.push((l) => { clearTimeout(timer); resolve(l); });
  });
}

describe('the server answers a challenge in its handshake', () => {
  // A real Daemon's connection handling, on a socket of its own. Its constructor
  // binds nothing and opens no project; it reads its socket and lock paths from
  // the state dir, pointed at a throwaway one here, and its query pool is off.
  const savedEnv = { state: process.env.CODEGRAPH_STATE_DIR, pool: process.env.CODEGRAPH_QUERY_POOL_SIZE };
  afterEach(() => {
    for (const [key, value] of [['CODEGRAPH_STATE_DIR', savedEnv.state], ['CODEGRAPH_QUERY_POOL_SIZE', savedEnv.pool]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function serverOn(socketPath: string): Promise<void> {
    process.env.CODEGRAPH_STATE_DIR = tempDir('cg-proofstate-');
    process.env.CODEGRAPH_QUERY_POOL_SIZE = '0';
    const daemon = new Daemon() as unknown as {
      socketPath: string;
      handleConnection(socket: net.Socket): void;
      engine: { stop(): Promise<void> };
      builder: { stop(): Promise<void> };
    };
    daemon.socketPath = socketPath;
    cleanups.push(async () => {
      await daemon.engine.stop();
      await daemon.builder.stop();
    });
    const accepted = new Set<net.Socket>();
    const server = net.createServer((socket) => { accepted.add(socket); daemon.handleConnection(socket); });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanups.push(() => new Promise<void>((resolve) => {
      for (const socket of accepted) socket.destroy();
      server.close(() => resolve());
    }));
  }

  async function connect(socketPath: string): Promise<{ socket: net.Socket; next: () => Promise<string> }> {
    const socket = net.createConnection(socketPath);
    socket.on('error', () => { /* torn down at the end */ });
    cleanups.push(() => { socket.destroy(); });
    const next = lineReader(socket);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    return { socket, next };
  }

  it('proves it holds this user\'s key, for the path it listens on, before the session starts', async () => {
    const socketPath = uniqueSocketPath();
    await serverOn(socketPath);
    const { socket, next } = await connect(socketPath);

    const hello = JSON.parse(await next());
    expect(hello.protocol).toBe(1);
    const challenge = newDaemonChallenge();
    socket.write(JSON.stringify({ codegraph_challenge: challenge }) + '\n');
    const { codegraph_proof: proof } = JSON.parse(await next());

    expect(daemonProofMatches(readDaemonKey()!, challenge, socketPath, proof)).toBe(true);
    socket.write(JSON.stringify({ codegraph_client: 1, pid: process.pid, hostPid: null }) + '\n');
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }) + '\n');
    expect(JSON.parse(await next())).toMatchObject({ id: 5, result: {} });
  });

  it('proves itself to a proxy\'s session hello, which carries the launch directory and scope too', async () => {
    const socketPath = uniqueSocketPath();
    await serverOn(socketPath);
    const { socket, next } = await connect(socketPath);

    await next(); // hello
    const challenge = newDaemonChallenge();
    socket.write(JSON.stringify({ codegraph_challenge: challenge }) + '\n');
    const { codegraph_proof: proof } = JSON.parse(await next());
    expect(daemonProofMatches(readDaemonKey()!, challenge, socketPath, proof)).toBe(true);
    const launchDir = tempDir('cg-prooflaunch-');
    const outside = tempDir('cg-proofoutside-');
    socket.write(JSON.stringify({
      codegraph_client: 1, pid: process.pid, hostPid: null,
      launchDir, focus: [], tools: '',
    }) + '\n');
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n');
    expect(JSON.parse(await next())).toMatchObject({ id: 7, result: {} });
    socket.write(JSON.stringify({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'codegraph_explore', arguments: { query: 'example', projectPath: outside } },
    }) + '\n');
    const answer = JSON.parse(await next());
    expect(answer.id).toBe(8);
    expect(answer.result.content[0].text).toContain(launchDir);
    expect(answer.result.content[0].text).toContain('outside it');
  });

  // A client hello without a challenge (the codegraph CLI's control hello sends
  // none) gets its session with no line ahead of it.
  it('sends no proof line to a client hello without a challenge', async () => {
    const socketPath = uniqueSocketPath();
    await serverOn(socketPath);
    const { socket, next } = await connect(socketPath);

    await next(); // hello
    socket.write(JSON.stringify({ codegraph_client: 1, pid: process.pid, hostPid: null }) + '\n');
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' }) + '\n');

    expect(JSON.parse(await next())).toMatchObject({ id: 6, result: {} });
  });
});
