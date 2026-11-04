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
  operator enables one by short name in `CODEGRAPH_MCP_TOOLS` of the session's own launcher, e.g.
  `explore,my_tool`. As with built-ins, with no allowlist a call to it is still served; with one,
  only listed tools are.
- The tiny-repo gate (CLI only) keeps explore, search, node and extension tools: an operator who
  named a tool meant it.
- **Runs in a worker or on the main thread.** `handle` runs inside a query-pool worker only when the
  pool is attached, healthy and warm and the call has a project; otherwise on the main thread. Write
  it to work in either. A worker loads the extensions itself from the env it inherited. Keep the
  module's top level light and pure — it is loaded on the main thread and in every worker — and work
  only from `args` and `ctx`. `ctx.getCodeGraph(projectPath)` returns that project and throws the same errors the built-in handlers get (`NotIndexedError`,
  `PathRefusalError`, the WSL-shared-index and database-open failures); `executeReadTool` turns them
  into the usual responses.
- **`ctx.focus` is the session's focus, for this call's worktree.** The absolute canonical directories
  the calling session's `serve --mcp --focus <dir>` named (each `<dir>` is relative to the repository
  root), resolved against the root of the git worktree the call is answered from: a call whose
  `projectPath` is a sibling worktree of the session's repository gets that worktree's directories.
  `[]` when the session has no focus or no worktree can be named for the call. The server sets it for every call; a client's argument cannot (`dispatchToolCall` strips
  the internal keys that carry it and the extension's `args` never contain them). A tool that narrows
  its answer compares an index with `focusPrefixesFor` and `inFocus` (`server/session-scope.ts`).
- **A session's own env decides what it lists and may call; the server's decides what is loaded.**
  Each client's launcher sends its raw `CODEGRAPH_MCP_TOOLS` (and its focus) in its client hello, so
  `tools/list` and the `tools/call` refusal use that session's list, in whichever order the sessions
  started. The one machine server has the env of whichever client started it, so its
  `CODEGRAPH_EXTENSION_MODULES` still decides which extensions are loaded at all, even if a later
  client's env names others; a client whose hello carries no `tools` (an older launcher) is gated by
  the server's own `CODEGRAPH_MCP_TOOLS`.

## The machine server and its state dir

One CodeGraph MCP server runs per state dir, started by the first `serve --mcp` client when none is
running; it never exits when idle (`codegraph daemon --stop` stops it). It answers for any project a
session names, so the server itself is keyed on no project root; the per-project records it and the builder
keep (holds, cold-build and seed state, registry records, writer locks) are keyed by `canonicalProjectRoot`
(`src/directory.ts`).

- **State dir.** `~/.codegraph`, or the absolute path in `CODEGRAPH_STATE_DIR`
  (`server/state-dir.ts`: `getStateDir()` creates nothing, `ensureStateDir()` makes it mode 0700; a
  relative value throws `InvalidStateDirError`). It holds `server.pid` and `server.log`, and
  `server.sock` unless the path is too long or the filesystem cannot host a socket, `builder.pid` and
  `builder.log` (the index builder's pid record and job log), plus the project
  registry (`projects/`). Read on every call, never cached.
- **State dir identity.** `getStateDirIdentity()` is the directory's own identity (`dev:ino`; the
  lower-cased native realpath on Windows; null until the dir exists). The lock's `stateId`, the
  tmpdir socket name and the Windows pipe name use it, and lock judgement compares it, never the
  path, so two spellings of one directory (a macOS firmlink) are one state dir and a copied state
  dir is another. The lock's `stateDir` path is for display only.
- **A development build** sets `CODEGRAPH_STATE_DIR` to its own directory and so runs its own server
  beside the live one: two state dirs never share a socket, a lock or a registry record, and stopping
  one leaves the other.
- **Control** (`src/mcp/server-control.ts`): `probeServer`, `stopServer` (identity verified by the
  server's socket hello before any signal), `requestProjectRelease` (what `codegraph index` and `codegraph uninit` call
  before they rebuild or delete a project's index in their own process, when no server routes the write to its
  builder: the server closes its handle and the builder drops its hold, and 'released' is answered
  after both). Paths and the lock record are in `src/mcp/daemon-paths.ts`.
- **CLI writes** (`builder/cli-route.ts`, wire in `builder/cli-wire.ts`). `codegraph init`, `index`
  and `sync`, and the `--fresh` wait of the commands that answer from the index, and `uninit`'s release (see below), ask a running
  server whose index builder is up to have that builder do the write. `builderRoute()` is the one decision: `probeServer()` proved
  a server (a live `server.pid` whose socket hello names its pid and version), and the CLI holds one
  connection to its socket, with a client hello that carries `control: 1` and no `launchDir` (a control
  client, not an agent session; the server refuses these requests to any other peer, and `--verbose`
  returns the engine's console lines as `log` events). `builder.pid` is not consulted:
  a direct-mode builder writes the same file for its own state dir, so it proves nothing about a
  server. No server, or a server whose builder is not up, and the command writes in its own process; the route creates no file or directory and starts nothing. The requests are
  `codegraph/indexWrite` (`init`, `index`, `reindex`, `sync`, `release`) and `codegraph/indexWriteEnd`; the
  server's `codegraph/indexWriteEvent` notifications (relayed from the builder's progress events) carry an
  init's `initialized` event and the indexing progress, which the CLI renders with the same code as in-process. An `index` request leaves
  a lease on the connection (the root's `rebuild.pid` and `writer.pid`, held by the builder) so the
  interactive re-run (`reindex`) runs under it; the CLI ends it with `indexWriteEnd`, and the server
  releases it when the connection goes. `release` is `codegraph uninit`'s request: a fence of kind `release`
  (while it stands the builder starts no job that opens the root: `sync`, `init`, `index` and their re-runs
  refuse with "the index of <root> is being removed", as do a hold's open and its retry), the server and the builder let go of the
  root, the builder's `drain` (the answer waits until no job of that root runs or waits; other roots' jobs are
  not waited for), and no rebuild; the CLI then deletes `.codegraph` (opened read-only) and ends the lease. So
  when `release` answers, no job of the builder holds or can open the database. Two connections of upstream code
  that teardown does not track can outlive it: a hold's deferred index recovery that outlasted its wait, and the
  oversized-WAL checkpoint a writable open starts. With no
  builder to route to, `uninit` takes `rebuild.pid` and calls `requestProjectRelease` as `index` does
  (a server that does not confirm refuses it), and starts nothing and writes no `server.pid` or `builder.pid` (`uninit.ts`). A request sent and not answered (the connection dropped) fails
  the command: the write may have run, so it is never redone in-process. The `--fresh` wait then holds
  the index read-only and sends each sync as a `sync` request.
- **The index builder** (`builder/`, started by the server with itself, in direct mode by the direct
  session). The server only reads: it opens every index read-only and never syncs, watches, seeds,
  builds, recovers an index or takes `writer.pid`, `rebuild.pid` or `codegraph.lock`. Every index
  write is a job on the builder, a child process of the server (`BuilderClient`, `builder/client.ts`),
  one job at a time, a sync going ahead of any queued cold build (the one exception: the oversized-WAL
  checkpoint a writable open starts, which its job does not await). The builder holds each root a call
  names: an `open` job opens it writable (migrating it), then it recovers it (waiting at most a bounded
  time), watches it and queues its catch-up. The server's `ensure` resolves once the builder opened and
  migrated the index, or after a bounded wait (`CODEGRAPH_BUILDER_ENSURE_WAIT_MS`, default 10 s) when
  that open is queued behind a running job such as a cold build, or when the hold could not open it
  (another live writer, an open failure); the server then opens read-only whatever is on disk.
  A git worktree with no index gets one seeded
  from an indexed sibling
  or, when there is none, cold-built from the queue, and the calls meanwhile answer the building note.
  A directory outside git with no index is cold-built from the queue too, at the session's anchor root
  (the launch directory when the session is outside git, which the server sends with the call); an anchor
  that does not contain the path is refused and nothing is built. A call on a subdirectory builds the
  launch directory once, never an index of its own. The builder checks the anchor it is sent (it must
  contain the path and be a safe existing directory) before it creates anything. A directory it will not
  build (your home directory, a filesystem root, a parent of home) or whose build failed answers a
  not-indexed note that names the reason and points at the built-in tools and at a project inside it; no
  tool answer tells the agent to stop calling codegraph.
  It never exits on idle; it ends when its server does (its IPC channel closes), and the server restarts
  it when it dies (`<state dir>/builder.pid`, `builder.log`). Which index answers a path is
  `server/index-root.ts` `selectOwnIndexRoot`, for both the server (with a builder) and the builder: a
  sub-project index inside a worktree does not shadow the worktree's own, and it is decided on the path's
  real location, so a symlink into a nested checkout is answered from the index the builder builds for
  that checkout. A git repository nested inside an indexed checkout is its own worktree root with its own
  git common dir, so the outer index is another repository's and is never selected, admitted or refused
  for a path in it; when git cannot answer, no index above the path's git root is selected either
  (`ownIndexRootFor` fails closed), and the call gets the builder's not-indexed guidance. That holds on a builder engine
  whether or not the outer index covers the nested repository: an embedded clone that is not gitignored,
  or a submodule, is still not answered from the outer index; it gets its own. The builder seeds it from
  its own sibling worktrees or cold-builds it at its own root, unless `CODEGRAPH_NO_AUTO_SEED=1` turns automatic
  indexing off; calls answer the building note while that runs, and the not-indexed guidance when the copy or build fails.
  (A linked worktree of the checkout's own repository still borrows the checkout's index until it is
  seeded.) A path in a different repository than the session's still gets the anchor guidance. The proxy's
  in-process fallback (the server unreachable) and the query workers have no builder and are read-only;
  the CLI has no builder of its own and is not read-only: with a server whose index builder is up its writes go to that
  builder (see "CLI writes"), otherwise it writes in its own process. All three keep `selectIndexRoot`: a worktree with no
  index gets the not-indexed guidance there, and a nested repository the outer index leaves out gets the
  nested text.

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
another checkout when it has none (or built there by the index builder when no checkout has one). Add it to Claude Code's `settings.json` (absolute path to the
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
