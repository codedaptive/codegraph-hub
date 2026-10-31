/**
 * Test fixture for the session-focus gates (`session-focus.gate.test.ts`).
 *
 * Plain CommonJS with no imports from src/, loaded only when a test points
 * CODEGRAPH_EXTENSION_MODULES at it, the way test-extension.cjs is.
 *
 * Tool `codegraph_focus_probe` answers with JSON:
 * - `focus`: what its context carries as `ctx.focus`, or the text `<absent>`
 *   when the context has no focus field;
 * - `argKeys`: every key of `args` the handler received, so a gate can see
 *   whether an internal session key reached the extension.
 */
'use strict';

const extension = {
  name: 'host-focus-probe',

  tools: [
    {
      definition: {
        name: 'codegraph_focus_probe',
        description: 'Session-focus test tool: reports the focus its context carries and the argument keys it received.',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Project the call names.' },
          },
        },
      },
      handle(args, ctx) {
        const focus = ctx.focus === undefined ? '<absent>' : ctx.focus;
        return {
          content: [{ type: 'text', text: JSON.stringify({ probe: 'FOCUS_PROBE', focus, argKeys: Object.keys(args) }) }],
        };
      },
    },
  ],
};

module.exports = { extension };
