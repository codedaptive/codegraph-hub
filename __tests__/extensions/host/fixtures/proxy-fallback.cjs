// The real local-handshake proxy with the machine server unreachable, so every
// tools/call is served by its in-process fallback: a read-only engine with no
// default project and no index builder, exactly what `serve --mcp` builds when the server cannot be
// reached (src/mcp/index.ts makeFallbackEngine). Runs the BUILT modules in
// dist/, as the shipped binary does. CG_LAUNCH_DIR is the session's launch
// directory (the repo anchor's source).
const path = require('path');

const dist = path.resolve(__dirname, '../../../../dist/mcp');
const { runLocalHandshakeProxy } = require(path.join(dist, 'proxy.js'));
const { MCPEngine } = require(path.join(dist, 'engine.js'));

runLocalHandshakeProxy({
  launchDir: process.env.CG_LAUNCH_DIR,
  getDaemonSocket: async () => null,
  makeEngine: () => new MCPEngine(),
});
