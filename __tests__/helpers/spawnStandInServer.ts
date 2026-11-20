import { spawn, type ChildProcess } from 'child_process';
import { daemonKey } from '../../src/mcp/daemon-proof';

/**
 * A stand-in for this user's CodeGraph server: a node child bound to `socketPath`
 * that, on each connection, sends the server hello naming its own pid and
 * `version`, then answers a `codegraph_challenge` line with the daemon proof for
 * `socketPath`, keyed by `$HOME/.codegraph/daemon.key`. Hello and proof are what
 * stopServer asks for before it signals (src/mcp/server-control.ts).
 *
 * The key is made here, in the test process, under the HOME the suite's setup
 * gives the test file; the child inherits that HOME. The child writes the HMAC
 * out from the protocol rather than calling daemonProof, so a wrong proof in the
 * product is not mirrored here. `silent` sends nothing at all; `ignoreTerm`
 * survives SIGTERM. Resolves once it listens.
 */
export async function spawnStandInServer(
  socketPath: string,
  version: string,
  opts: { silent?: boolean; ignoreTerm?: boolean } = {},
): Promise<ChildProcess> {
  if (daemonKey() === null) throw new Error('no daemon key could be made under this HOME');
  const source = [
    "const net = require('net');",
    "const fs = require('fs');",
    "const os = require('os');",
    "const path = require('path');",
    "const { createHmac } = require('crypto');",
    'const [sock, version, mode] = process.argv.slice(1);',
    "if (mode === 'ignore-term') process.on('SIGTERM', () => {});",
    'net.createServer((c) => {',
    "  c.on('error', () => {});",
    "  if (mode === 'silent') return;",
    "  c.write(JSON.stringify({ codegraph: version, pid: process.pid, socketPath: sock, protocol: 1 }) + '\\n');",
    "  let buffer = '';",
    "  c.on('data', (chunk) => {",
    '    buffer += chunk;',
    "    for (let nl = buffer.indexOf('\\n'); nl >= 0; nl = buffer.indexOf('\\n')) {",
    '      const challenge = JSON.parse(buffer.slice(0, nl)).codegraph_challenge;',
    '      buffer = buffer.slice(nl + 1);',
    "      if (typeof challenge !== 'string') continue;",
    "      const key = fs.readFileSync(path.join(os.homedir(), '.codegraph', 'daemon.key'));",
    "      const proof = createHmac('sha256', key).update(['codegraph-daemon-proof-v1', challenge, sock].join('\\0')).digest('hex');",
    "      c.write(JSON.stringify({ codegraph_proof: proof }) + '\\n');",
    '    }',
    '  });',
    "}).listen(sock, () => console.log('ready'));",
  ].join('\n');
  const mode = opts.silent ? 'silent' : opts.ignoreTerm ? 'ignore-term' : 'answer';
  const child = spawn(process.execPath, ['-e', source, socketPath, version, mode], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('stand-in server exited before listening')));
    child.stdout!.on('data', (chunk) => { if (String(chunk).includes('ready')) resolve(); });
  });
  return child;
}
