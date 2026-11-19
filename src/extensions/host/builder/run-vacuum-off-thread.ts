/**
 * VACUUM the database at `dbPath` on a worker thread with its own connection, as the WAL checkpoint does
 * (src/db/index.ts checkpointWal), so the event loop of the VACUUM job's child (./vacuum-job.ts) keeps turning
 * during a VACUUM that may take minutes: the child still sees its IPC channel's 'disconnect' (the builder is
 * gone) and exits then (./job-child-main.ts). After the VACUUM a `wal_checkpoint(TRUNCATE)` copies the rewritten
 * pages into the main file so it shrinks now; a reader pinning the WAL leaves that checkpoint busy, and the file
 * then shrinks at a later checkpoint.
 *
 * Rejects with the error's message when the VACUUM fails, or when the worker errors or exits without an answer,
 * so the queue logs the job's end as failed.
 */
import { Worker } from 'node:worker_threads';

const workerSource = `
  const { workerData, parentPort } = require('node:worker_threads');
  let err = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.dbPath);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('VACUUM');
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } finally {
      db.close();
    }
  } catch (e) { err = String((e && e.message) || e); }
  parentPort.postMessage({ err });
`;

export function runVacuumOffThread(dbPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, { eval: true, workerData: { dbPath } });
    let settled = false;
    const finish = (err: string | null): void => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      if (err === null) resolve();
      else reject(new Error(err));
    };
    worker.once('message', (message: { err: string | null }) => finish(message.err));
    worker.once('error', (err) => finish(err.message));
    worker.once('exit', (code) => finish(`the VACUUM worker exited (code ${code}) without an answer`));
  });
}
