// node mcp-list.mjs <codegraph-bin> <project-dir>: initialize + tools/list over stdio, print tool names.
import { spawn } from 'node:child_process';
const [bin, dir] = process.argv.slice(2);
const p = spawn(bin, ['serve', '--mcp'], { cwd: dir, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const t0 = Date.now(); let listed = false;
const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
p.stdout.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); }
    if (m.id === 2) {
      if (!m.result?.tools) { console.error('tools/list failed:', JSON.stringify(m.error ?? m)); process.exitCode = 1; }
      else { listed = true; console.log('tools/list in', Date.now() - t0, 'ms:', m.result.tools.map((t) => t.name).join(',')); }
      p.kill('SIGTERM');
    }
  }
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fleet-check', version: '0' } } });
const timer = setTimeout(() => { console.error('timeout'); p.kill('SIGKILL'); process.exit(1); }, 30000);
// Exit 0 only when tools/list answered: a server that dies first is a failed check.
p.on('exit', (code, sig) => { clearTimeout(timer); console.log('server exited', code, sig, 'after', Date.now() - t0, 'ms'); if (!listed) process.exitCode = 1; });
