/**
 * A tiny stand-in for the machine server's socket, for tests of the callers of
 * `requestProjectRelease` (src/mcp/server-control.ts): `codegraph index` and
 * the unit tests of server-control itself. It binds the first socket candidate
 * of the current state dir (so the process under test finds it exactly where it
 * looks for the real server), sends the server hello, records the client-hello
 * and every JSON-RPC request line, and answers each request as the test says.
 *
 * Needs `CODEGRAPH_STATE_DIR` set in this process (the candidate list is keyed
 * on it) and, for a spawned CLI to find the same socket, in the child's env.
 * Never use it with the real `~/.codegraph`.
 */
import * as fs from 'fs';
import * as net from 'net';
import { getServerSocketPath } from '../src/mcp/daemon-paths';

export interface FakeServer {
  socketPath: string;
  /** Client-hello lines received (`codegraph_client` marker present). */
  clientHellos: Array<Record<string, unknown>>;
  /** JSON-RPC request lines received (everything that is not a client-hello). */
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface FakeServerOptions {
  /**
   * The reply to a request, or null to stay silent (the caller times out).
   * Default: `{ result: { released: true } }`.
   */
  reply?: (request: Record<string, unknown>) => Record<string, unknown> | null;
  /** The hello line to send; null sends none. Default: a valid server hello. */
  hello?: Record<string, unknown> | null;
}

export async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const socketPath = getServerSocketPath();
  const reply = options.reply ?? (() => ({ result: { released: true } }));
  const clientHellos: Array<Record<string, unknown>> = [];
  const requests: Array<Record<string, unknown>> = [];
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { /* a client that hung up */ });
    const hello = options.hello === undefined
      ? { codegraph: 'fake', pid: process.pid, socketPath, protocol: 1 }
      : options.hello;
    if (hello !== null) socket.write(JSON.stringify(hello) + '\n');
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (message.codegraph_client === 1) { clientHellos.push(message); continue; }
        requests.push(message);
        const answer = reply(message);
        if (answer !== null) socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...answer }) + '\n');
      }
    });
  });
  // A POSIX socket file left by an earlier test would make listen() fail.
  if (process.platform !== 'win32') fs.rmSync(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  return {
    socketPath,
    clientHellos,
    requests,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
