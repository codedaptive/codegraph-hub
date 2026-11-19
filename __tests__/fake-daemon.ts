/**
 * A stand-in for the machine server, for the proof's tests: a real socket
 * server (a named pipe on Windows) on the path a client looks for, speaking the
 * server's handshake. It says hello and answers a challenge-only line with a
 * proof line the way `proof` says:
 *   - `valid`: this user's key, this path, as the real server answers;
 *   - `other-key`: another key, as a stand-in another user put there would;
 *   - `other-path`: this user's key for another path, a proof relayed from
 *     this user's server listening elsewhere;
 *   - `null`: a null proof, as a server with no readable key answers;
 *   - `none`: no proof line, as a server from before the proof.
 * Then it answers each request with what `reply` returns (merged into the
 * JSON-RPC response), or stays silent when that is undefined.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { getServerSocketCandidates } from '../src/mcp/daemon-paths';
import { daemonKey, daemonProof } from '../src/mcp/daemon-proof';
import { CodeGraphPackageVersion } from '../src/mcp/version';

export type FakeProof = 'valid' | 'other-key' | 'other-path' | 'none' | 'null';

export interface FakeRequest {
  id?: unknown;
  method: string;
  params?: { query?: string };
}

/** A request as recorded: what the client asked, without its id. */
export interface RecordedRequest {
  method: string;
  params?: { query?: string };
}

export interface FakeDaemonOptions {
  /** Listen here instead of on the server's first socket candidate in the state dir. */
  socketPath?: string;
  version?: string;
  proof?: FakeProof;
  /** `{ result }` or `{ error }` for a request, or undefined to send nothing. */
  reply: (request: FakeRequest) => unknown | undefined;
  /** Whole messages to send ahead of each response, like a notification. */
  before?: unknown[];
}

export interface FakeDaemon {
  socketPath: string;
  /** Every request the client sent after the handshake. */
  requests: RecordedRequest[];
  /** Every complete line received from clients, in order. */
  lines: Record<string, unknown>[];
  challenges: string[];
  close(): Promise<void>;
}

export async function startFakeDaemon(opts: FakeDaemonOptions): Promise<FakeDaemon> {
  const socketPath = opts.socketPath ?? getServerSocketCandidates()[0]!;
  if (process.platform !== 'win32') fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  const requests: RecordedRequest[] = [];
  const lines: Record<string, unknown>[] = [];
  const challenges: string[] = [];
  const sockets = new Set<net.Socket>();
  const proofFor = (challenge: string): string | null => {
    const mode = opts.proof ?? 'valid';
    if (mode === 'none') return null;
    if (mode === 'other-key') return daemonProof(randomBytes(32), challenge, socketPath);
    // A key this process can't read (a test faking another uid) proves nothing, as in the server.
    const key = daemonKey();
    return key ? daemonProof(key, challenge, mode === 'other-path' ? `${socketPath}-elsewhere` : socketPath) : null;
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { /* a client that hung up */ });
    socket.write(JSON.stringify({ codegraph: opts.version ?? CodeGraphPackageVersion, pid: process.pid, socketPath, protocol: 1 }) + '\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        lines.push(message);
        if (typeof message.codegraph_challenge === 'string') {
          challenges.push(message.codegraph_challenge);
          const proof = proofFor(message.codegraph_challenge);
          if (opts.proof === 'null' || proof !== null) socket.write(JSON.stringify({ codegraph_proof: opts.proof === 'null' ? null : proof }) + '\n');
          continue;
        }
        if (message.codegraph_client) continue;
        requests.push({ method: message.method, params: message.params });
        for (const extra of opts.before ?? []) socket.write(JSON.stringify(extra) + '\n');
        const body = opts.reply(message);
        if (body !== undefined) socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...(body as object) }) + '\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    requests,
    lines,
    challenges,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
      if (process.platform !== 'win32') fs.rmSync(socketPath, { force: true });
    }),
  };
}
