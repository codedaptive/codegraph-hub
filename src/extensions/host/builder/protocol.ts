/**
 * The IPC messages between the server's {@link BuilderClient} (./client.ts) and the builder process
 * (./main.ts, ./service.ts). Plain JSON objects over the `child_process.fork` channel.
 *
 * A request carries `{ id, op, ...args }` and gets exactly one reply `{ id, ok, result | error }`. The builder
 * also pushes messages nobody asked for: `ready` once when it can take requests, `freshness` whenever a held
 * root's watcher state or pending set changes, `released` when the builder itself let a root go (its index
 * was removed).
 */
import type { BuilderFreshness } from './client';

export type BuilderRequest =
  | { id: number; op: 'ensure'; projectPath: string }
  | { id: number; op: 'caughtUp'; root: string }
  | { id: number; op: 'sync'; root: string }
  | { id: number; op: 'release'; root: string };

export type BuilderReply =
  | { id: number; ok: true; result: unknown }
  /** `errorName` is the error's class name: the client rebuilds a LockUnavailableError from it. */
  | { id: number; ok: false; error: string; errorName?: string };

export type BuilderPush =
  | { op: 'ready'; pid: number }
  | { op: 'freshness'; state: BuilderFreshness }
  | { op: 'released'; root: string };

export type BuilderToServer = BuilderReply | BuilderPush;

/** A message from the builder that is a reply (it has an `id`), not a push. */
export function isReply(message: BuilderToServer): message is BuilderReply {
  return typeof (message as { id?: unknown }).id === 'number';
}
