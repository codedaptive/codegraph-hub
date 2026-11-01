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
    'Regex search over every file the codegraph index has (only the session focus, when the session has one), with each hit grouped under its innermost enclosing ' +
    'symbol (function, method, class) and the groups ranked by how many incoming calls, references, imports and ' +
    'inheritance edges they have; a count marked `(N questionable)` includes N calls bound by name only, which ' +
    '`strict: true` leaves out. Use it when you need EVERY occurrence of a string or name, not the top ' +
    'matches. Hits outside any symbol are listed as module level. Capped at 300 hits; narrow with `in`. ' +
    'In a session started with --focus it searches only inside the focus, unless scope: "repo".',
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
      strict: { type: 'boolean', description: 'Leave name-matched (questionable) incoming calls out of the in-edge counts and ranking.' },
      json: { type: 'boolean', description: 'Return the structured result as JSON instead of text.' },
      scope: {
        type: 'string',
        enum: ['focus', 'repo'],
        description: 'Results stay inside the directories this session was started with (--focus). Pass "repo" to search the whole repository for this call. Has no effect when the session has no focus.',
      },
      projectPath: { type: 'string', description: 'REQUIRED: the root path of the code to search (or any directory inside it); the index of the repository it is in is the one used. There is no default project.' },
    },
    required: ['pattern'],
  },
};
