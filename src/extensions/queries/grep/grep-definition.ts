/**
 * The `codegraph_grep` MCP tool definition, as plain data with no imports, so
 * `../extension.ts` can hand it to the extension hook at load time without
 * loading the search (which pulls in the database layer). The handler is
 * `handleGrepTool` in `./grep-mcp`.
 */
export const GREP_TOOL = {
  // The extension hook only accepts names matching /^codegraph_[a-z][a-z0-9_]*$/.
  name: 'codegraph_grep' as const,
  description:
    'Regex search over every file the codegraph index has, with each hit grouped under its innermost enclosing ' +
    'symbol (function, method, class) and the groups ranked by how many incoming calls, references, imports and ' +
    'inheritance edges they have. Use it when you need EVERY occurrence of a string or name, not the top ' +
    'matches. Hits outside any symbol are listed as module level. Capped at 300 hits; narrow with `in`.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      // maxLength states a limit the server already enforces: ToolHandler.execute
      // (src/mcp/tools.ts) caps every `pattern` argument at MAX_PATH_LENGTH (4,096)
      // characters and answers a longer one with isError before this tool's handler runs.
      pattern: {
        type: 'string',
        maxLength: 4096,
        description:
          'Regex (must be valid as both a JavaScript and a ripgrep regex), or a literal string with fixed: true. ' +
          'At most 4,096 characters; a longer pattern is refused with an error.',
      },
      in: { type: 'string', description: 'Repo-relative path prefix to search under, e.g. "src/db".' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive match.' },
      fixed: { type: 'boolean', description: 'Treat the pattern as a literal string, not a regex.' },
      json: { type: 'boolean', description: 'Return the structured result as JSON instead of text.' },
      projectPath: { type: 'string', description: 'Path inside the project to search (the nearest .codegraph/ at or above it is used).' },
    },
    required: ['pattern'],
  },
};
