/**
 * A machine server of an older release, listening where a current launcher does
 * not look first (#2335). A launcher's probe walks the state dir's socket
 * candidates, so a server on any other socket is reached only through the lock
 * (`<state>/server.pid`), which says where that server is. Like a real server it
 * holds the state dir's lock, sends the hello on each connection and keeps it
 * open, and answers a `codegraph_challenge` line with the daemon proof for its
 * socket path, keyed by `$HOME/.codegraph/daemon.key` (made here if missing, as
 * a real server makes it; src/mcp/daemon-proof.ts): stopServer signals only a
 * server that proves itself. Other lines are ignored. On SIGTERM it lets go of
 * the lock if it still names it, drops its connections and exits, the shape of a
 * real server's shutdown. (On Windows SIGTERM is TerminateProcess, and the stop
 * clears what is left.)
 *
 *   node older-daemon.cjs <state dir> <version> <socket path> <state dir identity>
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createHmac, randomBytes } = require('crypto');

const [stateDir, version, socketPath, stateId] = process.argv.slice(2);
const lockPath = path.join(stateDir, 'server.pid');
const keyPath = path.join(os.homedir(), '.codegraph', 'daemon.key');

fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
try {
  fs.writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
} catch (err) {
  if (err.code !== 'EEXIST') throw err;
}
const key = fs.readFileSync(keyPath);

function answer(socket, line) {
  let challenge;
  try { challenge = JSON.parse(line).codegraph_challenge; } catch { return; }
  if (typeof challenge !== 'string') return;
  const proof = createHmac('sha256', key).update(`codegraph-daemon-proof-v1\0${challenge}\0${socketPath}`).digest('hex');
  socket.write(JSON.stringify({ codegraph_proof: proof }) + '\n');
}

const connections = new Set();
const server = net.createServer((socket) => {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
  socket.on('error', () => { /* the client went away */ });
  socket.write(JSON.stringify({ codegraph: version, pid: process.pid, socketPath, protocol: 1 }) + '\n');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      answer(socket, buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  });
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
  for (const socket of connections) socket.destroy();
  server.close(() => process.exit(0));
});
