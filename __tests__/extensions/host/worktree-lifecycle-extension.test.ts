/**
 * The host extension's `codegraph project list|pin|unpin|remove` command
 * (src/extensions/host/extension.ts), whose actions live in
 * src/extensions/host/worktree-lifecycle/cli.ts.
 *
 * Three checks:
 *   - registering is light: requiring the built dist/extensions/host/extension.js
 *     and calling its registerCommands on a commander Command loads none of the
 *     engine (dist/index.js, dist/mcp/engine.js), the database layer, the
 *     resolver, the extractors, the MCP tool handler (dist/mcp/tools.js), or any
 *     module under dist/extensions/host/worktree-lifecycle/ (cli.js among them),
 *     which the actions load with `await import`;
 *   - the default export registers `project` with the subcommands list (with
 *     -j/--json), pin <path>, unpin <path> and remove <path>;
 *   - the built CLI's --help lists `project` (found by the hook's discovery
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

describe('registering the host extension is light (built modules)', () => {
  it('requiring dist/extensions/host/extension.js and registering its commands loads none of the engine, dist/db/, dist/resolution/, dist/extraction/, dist/mcp/tools.js, dist/extensions/host/worktree-lifecycle/', () => {
    // Real path: require.cache keys are physical paths, so a symlinked dist must not hide a load.
    const distRoot = fs.realpathSync(path.resolve(__dirname, '../../../dist'));
    const script =
      `const ext = require(${JSON.stringify(path.join(distRoot, 'extensions/host/extension.js'))}).default;` +
      `const { Command } = require(${JSON.stringify(require.resolve('commander'))});` +
      'const program = new Command();' +
      'ext.registerCommands(program);' +
      "if (!program.commands.some((c) => c.name() === 'project')) throw new Error('project not registered');" +
      'process.stdout.write(JSON.stringify(Object.keys(require.cache)));';
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', env: childEnv() });
    expect(res.status, res.stderr).toBe(0);
    const loaded: string[] = JSON.parse(res.stdout);
    const heavyFiles = [
      path.join(distRoot, 'index.js'),
      path.join(distRoot, 'mcp', 'engine.js'),
      path.join(distRoot, 'mcp', 'tools.js'),
    ];
    const heavyDirs = ['db', 'resolution', 'extraction', path.join('extensions', 'host', 'worktree-lifecycle')];
    const heavy = loaded.filter(
      (p) => heavyFiles.includes(p) || heavyDirs.some((d) => p.startsWith(path.join(distRoot, d) + path.sep)),
    );
    expect(heavy).toEqual([]);
  });
});

describe('host extension registers the project command', () => {
  it('the default export adds `project` with list (-j/--json), pin <path>, unpin <path>, remove <path>', async () => {
    // Imported here rather than at the top so a missing module fails this test alone.
    const { default: hostExtension } = await import('../../../src/extensions/host/extension');
    const program = new Command();
    hostExtension.registerCommands!(program);
    const project = program.commands.find((c) => c.name() === 'project');
    expect(project, 'project command registered').toBeDefined();
    expect(project!.commands.map((c) => c.name()).sort()).toEqual(['list', 'pin', 'remove', 'unpin']);

    const list = project!.commands.find((c) => c.name() === 'list')!;
    expect(list.registeredArguments).toEqual([]);
    const json = list.options.find((o) => o.long === '--json');
    expect(json, 'list --json option').toBeDefined();
    expect(json!.short).toBe('-j');

    for (const name of ['pin', 'unpin', 'remove']) {
      const sub = project!.commands.find((c) => c.name() === name)!;
      const args = sub.registeredArguments;
      expect(args.map((a) => a.name()), `${name} arguments`).toEqual(['path']);
      expect(args[0].required, `${name} <path> is required`).toBe(true);
    }
  });
});

describe('built CLI lists project', () => {
  it('dist/bin/codegraph.js --help lists the project command', () => {
    const res = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf-8', env: childEnv() });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/^\s+project\b/m);
  });
});
