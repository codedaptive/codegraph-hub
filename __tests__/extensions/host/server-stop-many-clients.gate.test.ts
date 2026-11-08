import { expect, it } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { WASM_RUNTIME_FLAGS } from '../../../src/extraction/wasm-runtime-flags';
import { BIN, gateEnv, waitUntil } from './machine-server.harness';

// This process gate may exceed 5 s: startup is separate from shutdown, whose
// bound is 1 s grace + the builder's 5 s cap + 3 s scheduling margin.
it.runIf(process.platform !== 'win32')('exits and removes its socket and lock with 50 connected clients', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stop-many-')));
  const pidPath = path.join(dir, 'server.pid');
  const logPath = path.join(dir, 'server.log');
  const logFd = fs.openSync(logPath, 'a');
  const sockets: net.Socket[] = [];
  const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--mcp'], {
    cwd: dir,
    stdio: ['pipe', 'pipe', logFd],
    env: gateEnv(dir, {
      CODEGRAPH_DAEMON_INTERNAL: '1',
      CODEGRAPH_NO_WATCHDOG: '1',
      CODEGRAPH_NO_RELAUNCH: '1',
      CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '0',
      CODEGRAPH_SERVER_STOP_GRACE_MS: '1000',
      CODEGRAPH_QUERY_POOL_SIZE: '0',
    }),
  });
  fs.closeSync(logFd);
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  const output = () => stdout + fs.readFileSync(logPath, 'utf8');
  child.stdin.on('error', () => {});
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  try {
    expect(await waitUntil(() => fs.existsSync(pidPath) || child.exitCode !== null, 20_000), output()).toBe(true);
    expect(fs.existsSync(pidPath), output()).toBe(true);
    const lock = JSON.parse(fs.readFileSync(pidPath, 'utf8')) as { pid: number; socketPath: string };
    expect(lock.pid).toBe(child.pid);
    expect(await waitUntil(() => fs.existsSync(lock.socketPath), 10_000), output()).toBe(true);
    const answers = await Promise.all(Array.from({ length: 50 }, () => new Promise<boolean>((resolve, reject) => {
      const socket = net.createConnection(lock.socketPath);
      sockets.push(socket);
      let data = '';
      let receivedHello = false;
      let done = false;
      const timer = setTimeout(() => finish(new Error('no initialize response within 10 s')), 10_000);
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(true);
      };
      socket.on('error', (error) => finish(error));
      socket.on('close', () => finish(new Error('socket closed before initialize response')));
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString();
        let newline: number;
        while ((newline = data.indexOf('\n')) !== -1) {
          const line = data.slice(0, newline);
          data = data.slice(newline + 1);
          try {
            const message = JSON.parse(line) as { protocol?: number; pid?: number; id?: number; result?: unknown; error?: unknown };
            if (!receivedHello) {
              if (message.protocol !== 1 || message.pid !== lock.pid) throw new Error('invalid server hello');
              receivedHello = true;
              socket.write(JSON.stringify({ codegraph_client: 1, pid: process.pid, hostPid: process.ppid, launchDir: dir, focus: [], tools: '' }) + '\n');
              socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
                protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'shutdown-gate', version: '1.0.0' },
              } }) + '\n');
            } else if (message.id === 1) {
              if (message.error !== undefined || message.result === undefined) throw new Error(`initialize failed: ${line}`);
              finish();
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
    })));
    expect(answers.filter(Boolean)).toHaveLength(50);
    expect(sockets.filter((socket) => !socket.destroyed)).toHaveLength(50);
    expect(child.kill('SIGTERM')).toBe(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      exited,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 9_000); }),
    ]);
    clearTimeout(timer);
    expect(result, `server did not exit within 9 s; output: ${output()}`).toEqual({ code: 0, signal: null });
    expect(fs.readFileSync(logPath, 'utf8')).toContain('Shutting down (SIGTERM; clients=50)');
    expect(fs.existsSync(lock.socketPath)).toBe(false);
    expect(fs.existsSync(pidPath)).toBe(false);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited.catch(() => undefined);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 40_000);
