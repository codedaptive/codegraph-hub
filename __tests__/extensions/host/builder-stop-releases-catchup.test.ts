import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuilderClient } from '../../../src/extensions/host/builder/client';

const forkStub = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  fork: forkStub,
}));

describe('BuilderClient stop with a pending catch-up', () => {
  // The fake child never exits after disconnect, exercising the real 5 s stop cap.
  it('releases a held root catch-up without a reply when stop reaches its cap', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stop-catchup-')));
    const child = new EventEmitter() as EventEmitter & {
      connected: boolean;
      send: (message: { id: number; op: string; projectPath?: string }) => void;
      disconnect: () => void;
      unref: () => void;
    };
    let catchUpSent!: () => void;
    const sent = new Promise<void>((resolve) => { catchUpSent = resolve; });
    child.connected = true;
    child.send = (message) => {
      if (message.op === 'ensure') {
        queueMicrotask(() => child.emit('message', { id: message.id, ok: true, result: { kind: 'ready', root } }));
      } else if (message.op === 'caughtUp') catchUpSent();
    };
    child.disconnect = () => { child.connected = false; };
    child.unref = () => {};
    forkStub.mockReturnValue(child);
    const client = BuilderClient.start();
    try {
      child.emit('message', { op: 'ready' });
      expect(await client.ensure(root)).toEqual({ kind: 'ready', root });
      let settled = false;
      const caughtUp = client.caughtUp(root).then(() => { settled = true; });
      await sent;
      expect(settled, 'catch-up must actually be waiting for the child').toBe(false);
      const start = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const completed = await Promise.race([
        Promise.all([client.stop(), caughtUp]).then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 6_500); }),
      ]);
      clearTimeout(timer);
      expect(completed, 'stop and catch-up must resolve within the 5 s cap plus 1.5 s scheduling margin').toBe(true);
      expect(Date.now() - start).toBeLessThan(6_500);
      expect(settled).toBe(true);
    } finally {
      child.emit('exit', 0, null);
      forkStub.mockReset();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
