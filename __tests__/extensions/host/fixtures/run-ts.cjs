/**
 * Runs a TypeScript fixture in this process: `node run-ts.cjs <fixture.ts> [-- args...]`.
 *
 * The host tests that need a separate OS process running the real code from src
 * (dead-lock-victim.ts, lock-takeover-competitor.ts) launch the running node
 * binary on this file. It registers a CommonJS `.ts` loader that strips types
 * with esbuild's transformSync, then requires the fixture. esbuild is not
 * declared in package.json: it is installed because vite depends on it, and
 * vite is a dependency of vitest (a root devDependency) and a devDependency of
 * the `ui` workspace. This file works only while vite keeps that dependency. Each .ts file is compiled on its
 * own as Node loads it, so every module keeps its own `__dirname` and resolves
 * its imports (extensionless relative paths, `index.ts` directories, packages
 * in node_modules, dynamic `import()` included) the way the repo's CommonJS
 * build does. A single bundle
 * would give every src module the bundle's `__dirname` instead.
 *
 * The fixture runs in this process, so its `process.pid` is the pid the test
 * spawned. `process.argv` is rewritten to `[node, <fixture>, ...args]`, so a
 * fixture reads its arguments from `process.argv.slice(2)`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { transformSync } = require('esbuild');

const [, , entry, ...rest] = process.argv;
if (!entry) {
  process.stderr.write('usage: node run-ts.cjs <fixture.ts> [-- args...]\n');
  process.exit(2);
}

require.extensions['.ts'] = (mod, filename) => {
  const { code } = transformSync(fs.readFileSync(filename, 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    target: `node${process.versions.node.split('.')[0]}`,
    // `import()` becomes `require()`, as tsc's `module: commonjs` build emits it. Left native, a dynamic
    // import of an extensionless relative path (`await import('../src/mcp/daemon')`) goes to the ESM
    // loader, which does not try `.ts` or `index.ts` and fails with ERR_MODULE_NOT_FOUND.
    supported: { 'dynamic-import': false },
    sourcefile: filename,
    sourcemap: 'inline',
  });
  mod._compile(code, filename);
};
// Stack traces from a failing fixture point at the .ts lines, through the inline maps.
process.setSourceMapsEnabled(true);

const fixture = path.resolve(entry);
process.argv = [process.argv[0], fixture, ...rest];
require(fixture);
