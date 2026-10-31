# Extension hook (zone host)

How a fork zone adds CLI commands and MCP tools to CodeGraph without editing
upstream files. Types: `api.ts`. Loader: `registry.ts`.

## Registering

Write `src/extensions/<zone>/extension.ts` and export a `CodegraphExtension` as
`default`:

```ts
import type { CodegraphExtension } from '../host/api';
const extension: CodegraphExtension = {
  name: '<zone>',
  registerCommands(program) { program.command('my-cmd').action(() => { /* ... */ }); },
  tools: [{ definition: { name: 'codegraph_my_tool', /* ... */ }, handle(args, ctx) { /* ... */ } }],
};
export default extension;
```

Nothing else to edit. The build compiles it to `dist/extensions/<zone>/extension.js`.

Registration runs on every CLI call and every MCP session start, so it must load nothing heavy: a
registration file imports only types and Node built-ins (`node:*`) at top level, loads the engine,
`src/db`, `src/resolution`, `src/extraction` (and anything that pulls them in) with `await import(...)`
inside its CLI action and MCP `handle`, and has a test proving through `require.cache` that
registering loads none of them.

## Loading

Once per process, never throwing. A module that fails to load (whatever it throws, even a value
that cannot be printed), or exports no value with a string `name`, is one
`[CodeGraph] extension <path> skipped: <reason>` line on stderr and the modules after it still load. An extension whose `tools` is present but not an array keeps its `registerCommands`
and loses all its tools, with one `[CodeGraph] extension <name>: tools dropped: ...` line.

1. **Discovery**: every directory under `extensions/` (in `dist/`) holding a compiled `extension.js`,
   in lexicographic UTF-16 code-unit order of the directory name (JavaScript string comparison; not
   code-point order, not locale order). `.ts` is never matched, so under vitest (which runs
   `src/`) nothing is discovered.
2. **`CODEGRAPH_EXTENSION_MODULES`**: comma-separated **absolute** paths to more modules (a relative
   entry is skipped with a warning). A module's extension is `module.default ?? module.extension`.

Every CLI invocation that reaches `program.parse()` (`serve --mcp` included; not the bare installer
run or `-v`) loads them at startup, just before `program.parse()`. A process that builds an MCP
server without the CLI loads them on its first `tools/list` or `tools/call`. A query-pool worker
reaches the registry only from `dispatchTool`'s default branch, so it loads them on its first
dispatch of a non-built-in tool name.

## Commands

`registerCommands(program)` is synchronous (the CLI's `main()` is) and adds `program.command(...)`
entries. One that throws is skipped with a warning, and so is the rest of that extension's
`registerCommands`. A command name that collides with a built-in makes commander throw, so the
extension's commands after it are skipped.

## Tools

- **Names** match `/^codegraph_[a-z][a-z0-9_]*$/` and may not take a built-in's name or an earlier
  extension tool's. A definition also needs a string `description` and an `inputSchema` with
  `type: 'object'` and a `properties` object, and a tool needs a `handle` function. A tool that
  breaks a rule, or whose properties throw when read (or whose definition JSON cannot copy), is
  dropped with a warning; its extension's other tools are still tried.
- **Registered once, as a snapshot.** The registry copies `definition` through JSON at registration,
  checks the copy, freezes it, and serves and looks up only that copy; `handle` is read once too. A
  getter that answers differently later, or a change to the extension's objects afterwards,
  changes nothing. Every served definition also gets the optional boolean `fresh` and `checkpoint`
  properties, which `src/mcp/tools.ts` adds to every tool's `inputSchema`; `ToolHandler.execute`
  handles them before and after `handle`, so `handle` needs nothing for them (it still receives them
  in `args`).
- **Annotations are set by the registry.** Every extension tool is served with the built-in tools'
  read-only MCP annotations (`readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`,
  `openWorldHint: false`, handed in from `src/mcp/tools.ts`), in `tools/list` and wherever the tool
  is looked up. An extension's own `annotations` are replaced, so an extension does not set them.
- **Off by default.** No extension tool is on the default surface (`codegraph_explore` alone). An
  operator enables one by short name in `CODEGRAPH_MCP_TOOLS`, e.g. `explore,my_tool`. As with
  built-ins, with no allowlist a call to it is still served; with one, only listed tools are.
- **Exempt from the tiny-repo gate** (<500 files keeps only explore/search/node): an operator who
  named a tool meant it.
- **Runs in a worker or on the main thread.** `handle` runs inside a query-pool worker only when the
  pool is attached, healthy and warm and the call has a project; otherwise on the main thread. Write
  it to work in either. A worker loads the extensions itself from the env it inherited. Keep the
  module's top level light and pure — it is loaded on the main thread and in every worker — and work
  only from `args` and `ctx`. `ctx.getCodeGraph(projectPath?)` returns that project (or the session
  default) and throws the same errors the built-in handlers get (`NotIndexedError`,
  `PathRefusalError`, the WSL-shared-index and database-open failures); `executeReadTool` turns them
  into the usual responses.
- **The daemon's env decides what can be called.** Behind the proxy, `tools/list` comes from the
  client process's env and extensions (`getStaticTools`), `tools/call` from the daemon's. A shared
  daemon has the env of whichever client started it, so its `CODEGRAPH_EXTENSION_MODULES` and
  `CODEGRAPH_MCP_TOOLS` decide what can be called, even if the client lists something else.

## Avoiding an import cycle

`src/mcp/tools.ts` imports `registry.ts` as a value. So `registry.ts` and `api.ts` import nothing from
`tools.ts` but types (a type-only import adds nothing to the runtime graph, so it cannot create a
runtime cycle); tools.ts hands the registry its built-in names and annotations through `setBuiltins`.
An extension module may import from `src/` (tools.ts included): it is required only from inside a
registry call, after `registry.ts` itself has finished loading, so it never meets a half-loaded
registry. Its value imports from `src/` still stay off its top level (see "Registering").

## Worktree hook (Claude Code PreToolUse)

A standalone Claude Code hook command, not an extension module: `registry.ts` and
`CODEGRAPH_EXTENSION_MODULES` do not load it.

`dist/extensions/host/worktree-hook/main.js` pins every codegraph MCP call to the git root of the
agent's own cwd, so an agent in a linked worktree queries that worktree's own index, copied in from
another checkout when it has none. Add it to Claude Code's `settings.json` (absolute path to the
built file):

```json
{"hooks":{"PreToolUse":[{"matcher":"mcp__codegraph__.*","hooks":[{"type":"command","command":"node /abs/path/to/dist/extensions/host/worktree-hook/main.js"}]}]}}
```

- The matcher names the MCP server key `codegraph`. A plugin-scoped server is named
  `mcp__plugin_<plugin>_codegraph__…` and needs its own matcher.
- `codegraph install` does not add it.
- Outside a git repo it does nothing, and it never fails a call: bad input, git missing or any error
  inside the hook prints nothing and exits 0. A crash before the hook's code runs exits 1, which Claude
  Code treats as non-blocking.
- It overrides any `projectPath` with the git root, a sub-project path included. That assumes the index
  sits at the git root: in a monorepo whose index lives only in a sub-project, calls go to the root and
  find no index.
- It answers `allow`, so a matched call skips the permission prompt (except the cases the hooks doc
  lists, such as MCP tools marked `requiresUserInteraction`). Allow is granted on the tool-name prefix
  alone, so any server keyed `codegraph` gets it. The codegraph tools do not edit source files, but they
  can update the `.codegraph/` index. Deny and ask rules still apply.

## Testing

In-process (vitest, `src/`): point `CODEGRAPH_EXTENSION_MODULES` at a fixture, or call
`registerExtension(ext)` (validated the same way as a loaded module, and never throwing), and call `__resetExtensionsForTests()` before and after so each test
re-reads the env. CLI and worker paths need `dist/` (see `__tests__/extensions/host/`).
