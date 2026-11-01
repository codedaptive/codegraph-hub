/**
 * One contender for a `FileLock`, run as its own process by
 * filelock-stale-takeover.test.ts (#2979).
 *
 *   node filelock-contender.cjs <utils.js> <lock> <markers> <name> <pause>
 *
 * It takes the lock with the built `FileLock`, writes `<name>.acquired` (and
 * holds the lock until `<name>.release` appears) or `<name>.refused`, then
 * exits. With `<pause>` = `pause`, it stops right after its first read of the
 * lock file (by path or through an fd opened on it), with whatever that read
 * returned in hand, writes `<name>.read`,
 * and waits for `go`: the moment a slow process has decided a lock is stale
 * but has not acted on it yet. Every wait is on a marker file the test writes,
 * so the interleaving is the same on every run. A contender gives up after
 * 30 s of waiting, so none outlives a test that stopped driving it.
 */
const fs = require('fs');
const path = require('path');

const [utilsJs, lockPath, markers, name, pause] = process.argv.slice(2);
const marker = (suffix) => path.join(markers, `${name}.${suffix}`);
const mark = (suffix, text = String(process.pid)) => fs.writeFileSync(marker(suffix), text);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (file) => {
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) process.exit(3);
    sleep(5);
  }
};

if (pause === 'pause') {
  const target = path.resolve(lockPath);
  // `FileLock.acquire` reads the lock once, through an fd it opens on the lock
  // path (`snapshotLock`), and judges staleness from that read alone. Track
  // the fds opened on the lock path so the pause lands right after that read.
  const open = fs.openSync;
  const close = fs.closeSync;
  const lockFds = new Set();
  fs.openSync = function openTracked(file, ...rest) {
    const fd = open.call(this, file, ...rest);
    if (typeof file === 'string' && path.resolve(file) === target) lockFds.add(fd);
    return fd;
  };
  fs.closeSync = function closeTracked(fd, ...rest) {
    lockFds.delete(fd);
    return close.call(this, fd, ...rest);
  };
  const read = fs.readFileSync;
  let paused = false;
  fs.readFileSync = function readThenPause(file, ...rest) {
    const content = read.call(this, file, ...rest);
    const isLock = typeof file === 'number' ? lockFds.has(file) : typeof file === 'string' && path.resolve(file) === target;
    if (!paused && isLock) {
      paused = true;
      mark('read', String(content));
      waitFor(path.join(markers, 'go'));
    }
    return content;
  };
}

const { FileLock } = require(utilsJs);
const lock = new FileLock(lockPath);
try {
  lock.acquire();
} catch (err) {
  mark('refused', err instanceof Error ? err.message : String(err));
  process.exit(0);
}
mark('acquired');
waitFor(marker('release'));
lock.release();
mark('released');
