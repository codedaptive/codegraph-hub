/**
 * Runs builder jobs each in its own child process (./job-child-main.ts), so the watchdog (./job-watchdog.ts) reads
 * each job's memory on its own and a limit (./job-limit-guard.ts) kills only that job's process; the builder and
 * the jobs beside it go on. A run sends the child its spec (./job-spec-type.ts), hands its progress to the
 * caller, and settles when the child has closed: with the body's result, with its error (an Error with the
 * thrown error's message and name, not an instance of its class), or, when the child ended with neither
 * (killed, or exited on its own), with an error naming its exit code or signal.
 *
 * The children are forked with the flags the builder itself runs with (./client.ts) and share its stderr.
 */
import { fork, type ChildProcess } from 'child_process';
import * as path from 'path';
import { NODE_RUNTIME_FLAGS, WASM_RUNTIME_FLAGS } from '../../../extraction/wasm-runtime-flags';
import type { JobChildMessage } from './job-child-message-type';
import type { JobSpecMessage } from './job-spec-message-type';
import type { JobSpec } from './job-spec-type';
import type { JobKind } from './queue';

export class JobSupervisor {
  /** The running children by job id, each with its job's spec, the promise of its 'close' and whether {@link kill} ended it. */
  private readonly children = new Map<number, { child: ChildProcess; spec: JobSpec; closed: Promise<void>; killed: boolean }>();
  /**
   * The database identity each job's child reported, by job id. A child that closes without a kill drops its
   * entry then, so identities do not pile up for the builder's life. A killed job's entry outlives its child,
   * since the guard cleans up after the kill has closed it: the first read after the close drops it.
   */
  private readonly databases = new Map<number, string | null>();
  private readonly entry: string;
  private readonly execArgv: readonly string[];

  constructor(opts: { entry?: string; execArgv?: readonly string[] } = {}) {
    this.entry = opts.entry ?? path.join(__dirname, 'job-child-main.js');
    this.execArgv = opts.execArgv ?? [...WASM_RUNTIME_FLAGS, ...NODE_RUNTIME_FLAGS];
  }

  /**
   * Run `spec` in a new child for job `jobId`; `onProgress` gets each progress payload in order. Resolves with
   * the body's result as `T`, the result type the caller names for the body `spec` names (./job-runner-type.ts).
   */
  run<T>(jobId: number, spec: JobSpec, onProgress?: (payload: unknown) => void): Promise<T> {
    this.databases.delete(jobId);
    return new Promise<T>((resolve, reject) => {
      const child = fork(this.entry, [], {
        execArgv: [...this.execArgv],
        env: process.env,
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      let outcome: { ok: true; value: T } | { ok: false; error: Error } | null = null;
      let settle: () => void = () => undefined;
      const closed = new Promise<void>((done) => { settle = done; });
      const finish = (ended: Error): void => {
        if (!this.children.get(jobId)?.killed) this.databases.delete(jobId);
        this.children.delete(jobId);
        settle();
        if (outcome === null) reject(ended);
        else if (outcome.ok) resolve(outcome.value);
        else reject(outcome.error);
      };
      this.children.set(jobId, { child, spec, closed, killed: false });
      child.on('close', (code, signal) => {
        finish(new Error(`job child ended without a result (${signal ? `signal ${signal}` : `exit code ${code}`})`));
      });
      // A child that could not be started has no pid and may never close; one that started always closes.
      child.on('error', (err) => {
        if (child.pid === undefined) finish(err);
        else outcome ??= { ok: false, error: err };
      });
      child.on('message', (message: JobChildMessage) => {
        if (message.type === 'progress') onProgress?.(message.payload);
        else if (message.type === 'database-created') this.databases.set(jobId, message.identity);
        // The IPC channel carries the result as JSON with no type: the one place it is given the caller's.
        else if (message.type === 'result') outcome = { ok: true, value: message.value as T };
        else outcome = { ok: false, error: Object.assign(new Error(message.message), { name: message.name }) };
      });
      child.send({ type: 'spec', spec } satisfies JobSpecMessage);
    });
  }

  /** The pid of job `jobId`'s child while it runs; null before it starts and after it has closed. */
  childPid(jobId: number): number | null {
    return this.children.get(jobId)?.child.pid ?? null;
  }

  /**
   * The database identity job `jobId`'s child last reported; null when it reported none, or when its child closed
   * without a kill. A read after a killed child closed drops the entry.
   */
  createdDatabase(jobId: number): string | null {
    const identity = this.databases.get(jobId) ?? null;
    if (!this.children.has(jobId)) this.databases.delete(jobId);
    return identity;
  }

  /** SIGKILL job `jobId`'s child; resolves once it has closed, at once when no child runs for that id. */
  async kill(jobId: number): Promise<void> {
    const running = this.children.get(jobId);
    if (!running) return;
    running.killed = true;
    running.child.kill('SIGKILL');
    await running.closed;
  }

  /**
   * Kill every running child; resolves once all have closed, with each killed job's kind and root, its child's
   * pid and the database identity the child reported (null when none), for the cleanup after it
   * (./end-jobs-after-grace.ts).
   */
  async killAll(): Promise<{ kind: JobKind; root: string; pid: number; createdDatabase: string | null }[]> {
    const running = [...this.children].flatMap(([jobId, { child, spec }]) =>
      child.pid === undefined ? [] : [{ jobId, kind: spec.kind, root: spec.root, pid: child.pid }]);
    await Promise.all([...this.children.keys()].map((jobId) => this.kill(jobId)));
    return running.map(({ jobId, kind, root, pid }) => ({ kind, root, pid, createdDatabase: this.createdDatabase(jobId) }));
  }
}
