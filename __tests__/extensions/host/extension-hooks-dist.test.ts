/**
 * Extension hook, discovery path. The packed build loads extensions
 * only by discovery: the compiled registry scans its parent directory for
 * `<dir>/extension.js`, and no CODEGRAPH_EXTENSION_MODULES is set. Under vitest
 * the registry runs from src/ and discovery finds nothing, so the other host
 * tests never exercise it.
 *
 * This test copies the compiled dist/extensions/host/registry.js into a temp
 * `extensions/host/` tree and writes the fixture beside it, rather than
 * writing into dist/extensions/: dozens of test files run dist/bin/codegraph.js
 * in parallel, and a fixture there would change their --help and the
 * global-setup dist snapshot, and would survive a crashed run.
 *
 * The copy runs without tools.ts, so setBuiltins is never called; nothing
 * here depends on the built-in name filter or the read-only annotations.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DIST_REGISTRY = path.resolve(__dirname, '../../../dist/extensions/host/registry.js');

/** The compiled registry's exports this test drives. */
interface DistRegistry {
  loadExtensions(): readonly { name: string }[];
  extensionTools(): { definition: { name: string } }[];
  registerExtensionCommands(program: Command): void;
}

/** A discoverable extension: one tool and one CLI command. */
const FIXTURE_SOURCE = `'use strict';
module.exports = {
  extension: {
    name: 'zz-dist-fixture',
    tools: [{
      definition: {
        name: 'codegraph_dist_echo',
        description: 'Echoes its input (discovery fixture).',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
      handle: async (args) => ({ content: [{ type: 'text', text: String(args.text) }] }),
    }],
    registerCommands(program) {
      program.command('dist-echo').description('discovery fixture command');
    },
  },
};
`;

/** A TypeScript sibling; discovery takes `.js` only, so it must stay unloaded. */
const TS_SOURCE = `export const extension = { name: 'zz-ts-fixture', tools: [] };\n`;

describe('extension discovery in the compiled registry', () => {
  let tmp: string;
  let savedModules: string | undefined;
  let registry: DistRegistry;

  beforeEach(() => {
    savedModules = process.env.CODEGRAPH_EXTENSION_MODULES;
    delete process.env.CODEGRAPH_EXTENSION_MODULES;

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ext-dist-'));
    const extRoot = path.join(tmp, 'extensions');
    for (const dir of ['host', 'zz-fixture', 'zz-ts']) fs.mkdirSync(path.join(extRoot, dir), { recursive: true });
    fs.copyFileSync(DIST_REGISTRY, path.join(extRoot, 'host', 'registry.js'));
    fs.writeFileSync(path.join(extRoot, 'zz-fixture', 'extension.js'), FIXTURE_SOURCE);
    fs.writeFileSync(path.join(extRoot, 'zz-ts', 'extension.ts'), TS_SOURCE);

    // Node's own require, not vitest's: the registry's internal require must
    // load the fixture the way the packed build does. The temp path is new, so
    // the require cache cannot hand back another test's module state.
    registry = createRequire(__filename)(path.join(extRoot, 'host', 'registry.js')) as DistRegistry;
  });

  afterEach(() => {
    // Cache keys are real paths (macOS's tmpdir is a /private symlink).
    const req = createRequire(__filename);
    const real = fs.realpathSync(tmp);
    for (const key of Object.keys(req.cache)) if (key.startsWith(real)) delete req.cache[key];
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedModules === undefined) delete process.env.CODEGRAPH_EXTENSION_MODULES;
    else process.env.CODEGRAPH_EXTENSION_MODULES = savedModules;
  });

  it('loads the fixture by discovery and serves its tool', () => {
    expect(registry.loadExtensions().map(e => e.name)).toEqual(['zz-dist-fixture']);
    expect(registry.extensionTools().map(t => t.definition.name)).toContain('codegraph_dist_echo');
  });

  it('does not load an extension.ts sibling', () => {
    expect(registry.loadExtensions().map(e => e.name)).not.toContain('zz-ts-fixture');
  });

  it("adds the discovered extension's command to a fresh program", () => {
    const program = new Command();
    registry.registerExtensionCommands(program);
    expect(program.commands.map(c => c.name())).toContain('dist-echo');
  });
});
