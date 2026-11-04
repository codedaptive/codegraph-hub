/**
 * The machine server's socket is owner-only from the moment it exists (src/mcp/daemon.ts bindServerSocket).
 *
 * The server accepts the codegraph CLI's index writes from any connection that sends the control hello, so a
 * window between the bind and the chmod in which another user could connect is a window for that. `listen`
 * creates the socket with the process umask, so a permissive umask (0) with a state dir that already exists
 * at 0755, or the tmpdir fallback, gives it mode 0777 until the chmod after `listen`. These tests bind through the
 * same function the server uses, with umask 0, and read the socket's mode right after the bind, before the
 * chmod runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { bindServerSocket } from '../../../src/mcp/daemon';

describe.skipIf(process.platform === 'win32')('bindServerSocket permissions', () => {
  let dir: string;
  let priorUmask: number;
  let server: net.Server | undefined;

  beforeEach(() => {
    // A short path: a unix socket path is limited to about 100 characters.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgs-'));
    fs.chmodSync(dir, 0o755);
    priorUmask = process.umask(0);
  });

  afterEach(async () => {
    process.umask(priorUmask);
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the socket owner-only under umask 0 in a 0755 directory, before the chmod runs', async () => {
    const socketPath = path.join(dir, 's');

    // `listen` binds a path synchronously and reports it from a later tick, where the server chmods the socket.
    // Reading the mode right after the call, in the same tick, is reading what the bind created.
    const pending = bindServerSocket(socketPath, () => undefined);
    const modeAtBind = fs.statSync(socketPath).mode & 0o777;
    server = await pending;

    // A socket's creation mode is 0777 less the umask: 0700 under the server's 0077 (0777 under the test's umask 0).
    // Nothing for group or others at bind; the chmod after listening then makes it 0600.
    expect((modeAtBind & 0o077).toString(8), `socket mode at bind: ${modeAtBind.toString(8)}`).toBe('0');
    expect((fs.statSync(socketPath).mode & 0o777).toString(8)).toBe('600');
  });

  it('puts the umask back after the bind', async () => {
    server = await bindServerSocket(path.join(dir, 's'), () => undefined);
    expect(process.umask()).toBe(0);
  });

  it('puts the umask back when the bind fails', async () => {
    // A path past the socket path limit: listen cannot bind it.
    const tooLong = path.join(dir, 'x'.repeat(200));
    await expect(bindServerSocket(tooLong, () => undefined)).rejects.toBeDefined();
    expect(process.umask()).toBe(0);
  });
});
