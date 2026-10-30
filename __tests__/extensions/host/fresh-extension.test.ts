/**
 * The host zone's extension (src/extensions/host/extension.ts): the
 * `codegraph checkpoint [path] [--fresh] [-j, --json]` CLI command, contributed
 * through the extension hook (src/extensions/host/registry.ts).
 *
 * Three checks:
 *   - loading the built module is light: the host loads every zone's
 *     extension.js on every CLI invocation that reaches `program.parse()`
 *     (not the bare installer run or -v / -version), and a query-pool worker
 *     loads them on its first call of a tool that is not built in, so its top
 *     level must not pull in the engine (dist/index.js), the database layer,
 *     the resolver, the extractors, the MCP tool handler, or the command's own
 *     action module (dist/extensions/host/fresh/cli.js), which the action loads
 *     with `await import`;
 *   - the default export, given a fresh commander Command, registers
 *     `checkpoint` with a `[path]` argument and the `--fresh` and `-j/--json`
 *     options;
 *   - the built CLI's --help lists `checkpoint` (found by the hook's discovery
 *     under dist/extensions/, with CODEGRAPH_EXTENSION_MODULES removed).
 *
 * dist/ is built from src/ by vitest's globalSetup.
 */
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');

/** The child's env: no daemon, no relaunch, and nothing but discovery may supply an extension. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEGRAPH_NO_DAEMON: '1',
    CODEGRAPH_WASM_RELAUNCHED: '1',
    CODEGRAPH_ALLOW_UNSAFE_NODE: '1',
  };
  delete env.CODEGRAPH_EXTENSION_MODULES;
  delete env.CODEGRAPH_MCP_TOOLS;
  return env;
}

describe('host extension registration is light (built modules)', () => {
  it('requiring dist/extensions/host/extension.js loads none of dist/index.js, dist/db/, dist/resolution/, dist/extraction/, dist/mcp/tools.js, dist/extensions/host/fresh/cli.js', () => {
    // Real path: require.cache keys are physical paths, so a symlinked dist must not hide a load.
    const distRoot = fs.realpathSync(path.resolve(__dirname, '../../../dist'));
    const script =
      `require(${JSON.stringify(path.join(distRoot, 'extensions/host/extension.js'))});` +
      'process.stdout.write(JSON.stringify(Object.keys(require.cache)));';
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', env: childEnv() });
    expect(res.status, res.stderr).toBe(0);
    const loaded: string[] = JSON.parse(res.stdout);
    const heavyFiles = [
      path.join(distRoot, 'index.js'),
      path.join(distRoot, 'mcp', 'tools.js'),
      path.join(distRoot, 'extensions', 'host', 'fresh', 'cli.js'),
    ];
    const heavy = loaded.filter(
      (p) =>
        heavyFiles.includes(p) ||
        ['db', 'resolution', 'extraction'].some((d) => p.startsWith(path.join(distRoot, d) + path.sep)),
    );
    expect(heavy).toEqual([]);
  });
});

describe('host extension registers the checkpoint command', () => {
  it('the default export adds `checkpoint [path]` with --fresh and -j/--json to a fresh Command', async () => {
    // Imported here rather than at the top so a missing module fails this test alone.
    const { default: hostExtension } = await import('../../../src/extensions/host/extension');
    expect(hostExtension.name).toBe('host');
    expect(typeof hostExtension.registerCommands).toBe('function');

    const program = new Command();
    hostExtension.registerCommands!(program);
    const cmd = program.commands.find((c) => c.name() === 'checkpoint');
    expect(cmd, 'checkpoint command registered').toBeDefined();

    const args = cmd!.registeredArguments;
    expect(args.map((a) => a.name())).toEqual(['path']);
    expect(args[0].required).toBe(false);

    const fresh = cmd!.options.find((o) => o.long === '--fresh');
    expect(fresh, '--fresh option').toBeDefined();
    const json = cmd!.options.find((o) => o.long === '--json');
    expect(json, '--json option').toBeDefined();
    expect(json!.short).toBe('-j');
  });
});

describe('built CLI lists checkpoint', () => {
  it('dist/bin/codegraph.js --help lists the checkpoint command', () => {
    const res = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf-8', env: childEnv() });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/^\s+checkpoint\b/m);
  });
});
