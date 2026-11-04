/**
 * A machine server of an older release, listening where a current launcher does
 * not look first (#2335). A launcher's probe walks the state dir's socket
 * candidates, so a server on any other socket is reached only through the lock
 * (`<state>/server.pid`), which says where that server is. Like a real server it
 * holds the state dir's lock and answers the hello; on SIGTERM it lets go of the
 * lock if it still names it and exits, the shape of a real server's shutdown.
 * (On Windows SIGTERM is TerminateProcess, and the stop clears what is left.)
 *
 *   node older-daemon.cjs <state dir> <version> <socket path> <state dir identity>
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

const [stateDir, version, socketPath, stateId] = process.argv.slice(2);
const lockPath = path.join(stateDir, 'server.pid');

const server = net.createServer((socket) => {
  socket.end(JSON.stringify({ codegraph: version, pid: process.pid, socketPath, protocol: 1 }) + '\n');
});
server.listen(socketPath, () => {
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, version, socketPath, startedAt: Date.now(), stateDir, stateId }) + '\n',
  );
});
process.on('SIGTERM', () => {
  try {
    if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid === process.pid) fs.unlinkSync(lockPath);
  } catch { /* already gone */ }
  server.close(() => process.exit(0));
});
