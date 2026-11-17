import { EventEmitter } from 'events';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderClient } from '../../../src/extensions/host/builder/client';
import type { BuilderReply, BuilderRequest } from '../../../src/extensions/host/builder/protocol';

const forkStub = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  fork: forkStub,
}));
vi.mock('../../../src/extensions/host/server/index-root', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/extensions/host/server/index-root')>();
  return {
    ...actual,
    selectOwnIndexRoot: (p: string) => p.startsWith('/cg-late-ready/') ? p : actual.selectOwnIndexRoot(p),
  };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (p: Parameters<typeof actual.existsSync>[0]) =>
      typeof p === 'string' && p.endsWith(path.join('builder', 'main.js')) ? true : actual.existsSync(p),
  };
});

class FakeChild extends EventEmitter {
  connected = true;
  pid = 1234;
  requests: BuilderRequest[] = [];

  send(request: BuilderRequest): void { this.requests.push(request); }
  disconnect(): void { this.connected = false; }
  unref(): void {}
  ready(): void { this.emit('message', { op: 'ready', pid: this.pid }); }
  reply(reply: BuilderReply): void { this.emit('message', reply); }
  exit(): void { this.emit('exit', 1, null); }
  ensures(): Array<Extract<BuilderRequest, { op: 'ensure' }>> {
    return this.requests.filter((request): request is Extract<BuilderRequest, { op: 'ensure' }> => request.op === 'ensure');
  }
}

const root = path.resolve('/cg-late-ready/repo');
const sub = path.join(root, 'src');
const other = path.resolve('/cg-late-ready/repository-other');
const ask = (projectPath: string) => ({ op: 'ensure', projectPath });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('BuilderClient late ready', () => {
  let children: FakeChild[];
  let client: BuilderClient;

  beforeEach(() => {
    vi.useFakeTimers();
    children = [];
    forkStub.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    client = BuilderClient.start({ onLog: () => {} });
  });

  afterEach(async () => {
    const stopping = client.stop();
    for (const child of children) child.exit();
    await stopping;
    vi.useRealTimers();
    forkStub.mockReset();
  });

  it.each([root, path.resolve('/cg-no-own-index/repo')])('release cancels an ensure parked before ready for %s', async (buildRoot) => {
    const pending = client.ensure(path.join(buildRoot, 'nested', '..', 'src'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children[0].ensures()).toEqual([]);
    await client.release(buildRoot);
    children[0].ready();
    await flush();
    expect(children[0].ensures()).toEqual([]);
    expect(await pending).toEqual({ kind: 'none' });
    children[0].exit();
    await vi.advanceTimersByTimeAsync(200);
    children[1].ready();
    await flush();
    expect(children[1].ensures()).toEqual([]);
  });

  it('release cancels a deferred ensure re-sent on ready before it reaches the child', async () => {
    const pending = client.ensure(sub);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await pending).toEqual({ kind: 'none', pending: true });
    children[0].ready();
    const released = client.release(root);
    await flush();
    expect(children[0].ensures()).toEqual([]);
    const request = children[0].requests.find((item) => item.op === 'release');
    expect(request).toBeDefined();
    if (request) children[0].reply({ id: request.id, ok: true, result: null });
    await released;
    children[0].exit();
    await vi.advanceTimersByTimeAsync(200);
    children[1].ready();
    await flush();
    expect(children[1].ensures()).toEqual([]);
  });

  it('answers pending when an in-flight builder goes down', async () => {
    children[0].ready();
    const pending = client.ensure(sub);
    await flush();
    children[0].exit();
    expect(await pending).toEqual({ kind: 'none', pending: true });
  });

  it('waits past eight seconds for a builder serving a path without its own index', async () => {
    const unindexed = path.resolve('/cg-no-own-index/repo');
    let settled = false;
    const pending = client.ensure(unindexed).then((answer) => { settled = true; return answer; });
    await vi.advanceTimersByTimeAsync(8_001);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(21_999);
    expect(settled).toBe(false);
    children[0].ready();
    await flush();
    const request = children[0].ensures()[0];
    expect(request).toEqual(expect.objectContaining(ask(unindexed)));
    children[0].reply({ id: request.id, ok: true, result: { kind: 'building', root: unindexed } });
    expect(await pending).toEqual({ kind: 'building', root: unindexed });
  });

  it('gives up waiting for ready after eight seconds when the path has its own index', async () => {
    let settled = false;
    const pending = client.ensure(root).then((answer) => { settled = true; return answer; });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ kind: 'none', pending: true });
  });

  it('re-sends the original ask without an anchor after the startup wait expires', async () => {
    const pending = client.ensure(sub);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await pending).toEqual({ kind: 'none', pending: true });
    children[0].ready();
    await flush();
    expect(children[0].ensures()).toEqual([{ id: expect.any(Number), ...ask(sub) }]);
  });

  it('re-sends an in-flight ask after its builder exits', async () => {
    children[0].ready();
    const pending = client.ensure(sub);
    await flush();
    expect(children[0].ensures()).toEqual([expect.objectContaining(ask(sub))]);
    children[0].exit();
    expect(await pending).toEqual({ kind: 'none', pending: true });
    await vi.advanceTimersByTimeAsync(200);
    children[1].ready();
    await flush();
    expect(children[1].ensures()).toEqual([expect.objectContaining(ask(sub))]);
  });

  it.each(['down', 'up'] as const)('release while %s drops canonical descendant asks but keeps unrelated asks', async (state) => {
    const pending = [client.ensure(root), client.ensure(path.join(root, 'nested', '..', 'src')), client.ensure(other)];
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await Promise.all(pending)).toEqual([{ kind: 'none', pending: true }, { kind: 'none', pending: true }, { kind: 'none', pending: true }]);
    if (state === 'up') {
      children[0].ready();
      await flush();
    }
    const released = client.release(path.join(root, '.', 'child', '..'));
    if (state === 'up') {
      await flush();
      const request = children[0].requests.find((item) => item.op === 'release');
      expect(request).toBeDefined();
      if (request) children[0].reply({ id: request.id, ok: true, result: null });
    }
    await released;
    if (state === 'up') {
      children[0].exit();
      await vi.advanceTimersByTimeAsync(200);
    }
    const next = children[children.length - 1];
    const prior = next.ensures().length;
    next.ready();
    await flush();
    expect(next.ensures().slice(prior)).toEqual([expect.objectContaining(ask(other))]);
  });

  it('does not remember an in-flight ask released before its builder exits', async () => {
    const unrelated = client.ensure(other);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await unrelated).toEqual({ kind: 'none', pending: true });
    children[0].ready();
    await flush();
    const pending = client.ensure(sub);
    await flush();
    const released = client.release(root);
    await flush();
    const request = children[0].requests.find((item) => item.op === 'release');
    expect(request).toBeDefined();
    if (request) children[0].reply({ id: request.id, ok: true, result: null });
    await released;
    children[0].exit();
    expect(await pending).toEqual({ kind: 'none', pending: true });
    await vi.advanceTimersByTimeAsync(200);
    children[1].ready();
    await flush();
    expect(children[1].ensures()).toEqual([expect.objectContaining(ask(other))]);
  });

  it.each(['error reply', 'reply timeout'] as const)('does not remember a live builder failure from %s', async (failure) => {
    children[0].ready();
    const pending = client.ensure(sub);
    await flush();
    const request = children[0].ensures()[0];
    expect(request).toBeDefined();
    if (failure === 'error reply') children[0].reply({ id: request.id, ok: false, error: 'failed' });
    else await vi.advanceTimersByTimeAsync(120_000);
    expect(await pending).toEqual({ kind: 'none' });
    children[0].exit();
    await vi.advanceTimersByTimeAsync(200);
    children[1].ready();
    await flush();
    expect(children[1].ensures()).toEqual([]);
  });

  it('forgets a deferred ask when a later ensure receives an answer', async () => {
    const first = client.ensure(sub);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await first).toEqual({ kind: 'none', pending: true });
    children[0].ready();
    await flush();
    const later = client.ensure(sub);
    await flush();
    const request = children[0].ensures().at(-1);
    expect(request).toBeDefined();
    if (request) children[0].reply({ id: request.id, ok: true, result: { kind: 'none' } });
    expect(await later).toEqual({ kind: 'none' });
    children[0].exit();
    const unrelated = client.ensure(other);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await unrelated).toEqual({ kind: 'none', pending: true });
    children[1].ready();
    await flush();
    expect(children[1].ensures()).toEqual([expect.objectContaining(ask(other))]);
  });

  const releasesOf = (child: FakeChild, releasedRoot: string) =>
    child.requests.filter((request) => request.op === 'release' && request.root === releasedRoot);

  it.each([
    ['ready', { kind: 'ready', root }],
    ['seeded', { kind: 'seeded', root, source: other, method: 'copy' }],
  ] as const)('an ensure already sent when release runs answers %s as the builder gave it and is held again on restart', async (_kind, answer) => {
    children[0].ready();
    const pending = client.ensure(sub);
    await flush();
    const request = children[0].ensures()[0];
    const released = client.release(root);
    await flush();
    const [releaseRequest] = releasesOf(children[0], root);
    children[0].reply({ id: request.id, ok: true, result: answer });
    expect(await pending).toEqual(answer);
    await flush();
    expect(releasesOf(children[0], root)).toHaveLength(1);
    children[0].reply({ id: releaseRequest.id, ok: true, result: null });
    await released;
    children[0].exit();
    await vi.advanceTimersByTimeAsync(200);
    children[1].ready();
    await flush();
    expect(children[1].ensures()).toEqual([expect.objectContaining(ask(root))]);
  });

  it('an ensure already sent when release runs answers building and its build is re-asked on restart', async () => {
    children[0].ready();
    const pending = client.ensure(sub);
    await flush();
    const request = children[0].ensures()[0];
    const released = client.release(root);
    await flush();
    const [releaseRequest] = releasesOf(children[0], root);
    children[0].reply({ id: request.id, ok: true, result: { kind: 'building', root } });
    expect(await pending).toEqual({ kind: 'building', root });
    children[0].reply({ id: releaseRequest.id, ok: true, result: null });
    await released;
    children[0].exit();
    await vi.advanceTimersByTimeAsync(200);
    children[1].ready();
    await flush();
    expect(children[1].ensures()).toEqual([expect.objectContaining(ask(sub))]);
  });

  it('sends nothing on a late ready after stop starts', async () => {
    children[0].ready();
    const pending = client.ensure(sub);
    await flush();
    const request = children[0].ensures()[0];
    children[0].reply({ id: request.id, ok: true, result: { kind: 'building', root } });
    expect(await pending).toEqual({ kind: 'building', root });
    const stopping = client.stop();
    const prior = children[0].requests.length;
    children[0].ready();
    await flush();
    expect(children[0].requests.slice(prior)).toEqual([]);
    children[0].exit();
    await stopping;
  });
});
