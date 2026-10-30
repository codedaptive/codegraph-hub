/**
 * Test fixture for the extension hook.
 *
 * Plain CommonJS with no imports from src/, so the same file loads through the
 * registry in vitest (src), in the built CLI (dist) and in a dist query-pool
 * worker. It is loaded only when a test points CODEGRAPH_EXTENSION_MODULES at it.
 *
 * - command `ext-hello` proves registerCommands reached the CLI's commander program;
 * - tool `codegraph_ext_echo` proves dispatch reached the handler, that the
 *   handler got a real CodeGraph through ctx.getCodeGraph (the file count comes
 *   from the index), and which thread ran it (`thread:main` / `thread:worker`).
 */
'use strict';

const { isMainThread } = require('worker_threads');

const extension = {
  name: 'host-test',

  registerCommands(program) {
    program
      .command('ext-hello')
      .description('Extension hook test command')
      .action(() => {
        process.stdout.write('ext-hello ran\n');
      });
  },

  tools: [
    {
      definition: {
        name: 'codegraph_ext_echo',
        description: 'Extension hook test tool: echoes text with the project file count.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to echo back.' },
            projectPath: { type: 'string', description: 'Project to read the file count from.' },
          },
          required: ['text'],
        },
      },
      handle(args, ctx) {
        const projectPath = typeof args.projectPath === 'string' ? args.projectPath : undefined;
        const fileCount = ctx.getCodeGraph(projectPath).getStats().fileCount;
        const thread = isMainThread ? 'main' : 'worker';
        return {
          content: [{ type: 'text', text: `ext_echo:${String(args.text)}:${fileCount} thread:${thread}` }],
        };
      },
    },
  ],
};

module.exports = { extension };
