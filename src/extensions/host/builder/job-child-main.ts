/**
 * The child process one builder job runs in (forked by ./job-supervisor.ts), so a limit that ends it ends that
 * job alone. It waits for the job's spec (./job-spec-type.ts), loads the body module, calls its export with the
 * spec's `args` and a context (`progress`, `reportDatabase`, `writerPid`), and sends what the body reports, in
 * call order, then the result and exit 0, or the error and exit 1. It exits too when the builder's channel
 * closes, so no job writes on after its builder is gone.
 *
 * Each job pays this file's start-up, so it imports only node built-ins and types.
 */
import type { JobChildMessage } from './job-child-message-type';
import type { JobSpecMessage } from './job-spec-message-type';

function isSpecMessage(message: unknown): message is JobSpecMessage {
  return typeof message === 'object' && message !== null && 'type' in message && message.type === 'spec';
}

async function runSpec(
  { spec }: JobSpecMessage,
  channel: { send: (message: JobChildMessage) => void; exit: (code: number) => void },
  load: (modulePath: string) => Record<string, unknown>,
): Promise<void> {
  try {
    const body = load(spec.module)[spec.export];
    if (typeof body !== 'function') throw new Error(`job module ${spec.module} has no function export ${spec.export}`);
    const value: unknown = await body(spec.args, {
      progress: (payload: unknown) => channel.send({ type: 'progress', payload }),
      reportDatabase: (root: string, identity: string | null) => channel.send({ type: 'database-created', root, identity }),
      writerPid: spec.writerPid,
    });
    channel.send({ type: 'result', value });
    channel.exit(0);
  } catch (err) {
    channel.send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    channel.exit(1);
  }
}

/** Run the job of the spec message `channel` delivers; `load` returns a body module's exports. */
export function runJobChild(
  channel: {
    send: (message: JobChildMessage) => void;
    onMessage: (handler: (message: unknown) => void) => void;
    exit: (code: number) => void;
  },
  load: (modulePath: string) => Record<string, unknown>,
): void {
  channel.onMessage((message) => {
    if (isSpecMessage(message)) void runSpec(message, channel, load);
  });
}

/**
 * The process's own channel. Exit waits for the callback of the last message sent: IPC delivers in order, so
 * every message has left before the process ends.
 */
function startFromProcess(): void {
  const send = process.send?.bind(process);
  if (!send) {
    process.stderr.write('usage: a builder job is started by the index builder over an IPC channel\n');
    process.exit(2);
  }
  let sent = Promise.resolve();
  process.on('disconnect', () => process.exit(1));
  runJobChild({
    send: (message) => { sent = new Promise((resolve) => { send(message, () => resolve()); }); },
    onMessage: (handler) => { process.on('message', handler); },
    exit: (code) => { void sent.then(() => process.exit(code)); },
  }, (modulePath) => require(modulePath));
}

if (require.main === module) startFromProcess();
