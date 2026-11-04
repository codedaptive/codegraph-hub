CodeGraph Hub is a Fork of [CodeGraph](https://github.com/colbymchenry/codegraph) built for running many AI coding agents at once. Every session on your machine shares one server, agents can each query their own checkout, and the index keeps up as parallel work moves.

- **One shared server.** A single machine-wide server replaces the daemon per project, and idle project indexes close on their own.
- **The right code on every call.** Each MCP call names its repository or worktree, so parallel agents can stay on their own checkouts.
- **Worktrees that start ready.** A new worktree can copy the nearest sibling's index, and removed worktrees are cleaned up.
- **Orderly index builds.** A separate builder queues index writes, so agents don't compete to update the same index.
- **Answers you can verify.** Agents can wait for an up-to-date index or get a checkpoint of the indexed state.
- **Sessions that keep working.** If the shared server can't be reached, a session answers from existing indexes in read-only mode.
- **Focused searches.** A session focus narrows finding tools to the part of the repository you're working in.
- **Change review tools.** `grep` finds text and groups each hit under the symbol that contains it, `blast` shows what depends on the lines a change touched, `orphans` lists what a branch added that nothing uses, and `suspects` lists the call edges that need a second look.
- **Runs on Node 25 and later.** Upstream refuses to start on Node 25 (`engines` `>=20.0.0 <25.0.0`).
- **Fixes ahead of upstream.** The hub carries fixes for Swift and Rust resolution, index recovery, writer ownership, and syncs that re-read unchanged files.

For everything else CodeGraph does, see [upstream's README](UPSTREAM-README.md).

The hub tracks colbymchenry/codegraph and keeps its own feature set. It is brought up to date on the 4th of each month, or the next working day when the 4th falls on a weekend. It takes issues through GitHub Issues in this repository; an issue that needs a fix sooner gets one out of cycle.

## How to use it

The examples use `codegraph` for the built CLI; see the setup section to run it from a clone.

- **Server controls.** Use `codegraph daemon` to see the server and `codegraph daemon --stop` to stop it. Set `CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS` to change the ten-minute idle timeout, or `CODEGRAPH_STATE_DIR` to an absolute path to choose another state directory. `CODEGRAPH_HOUSEKEEPING_INTERVAL_MS` sets the periodic cleanup interval in milliseconds (default 60 seconds; `0` turns the periodic pass off).
- **Project controls.** Use `codegraph project list --json`, `codegraph project pin /path/to/project`, `codegraph project unpin /path/to/project` and `codegraph project remove /path/to/project`. Pinning keeps a project open; removing its registry entry deletes no files.
- **Fallback.** While serving in process, the session normally retries the server. It does not build or sync an index, even for `fresh: true`.
- **Query workers.** Spare workers retire on their own idle clocks after 60 seconds by default, while the last worker retains the upstream five-minute idle trim. Set `CODEGRAPH_QUERY_WORKER_IDLE_TIMEOUT_MS` in milliseconds to change spare-worker retirement; `0` turns it off.
- **Project path.** Pass `projectPath: "/path/to/project"` on an MCP call.
- **Builder.** A queued sync goes ahead of a queued full build. Set `CODEGRAPH_BUILDER_ENSURE_WAIT_MS` to change the bounded wait for an index to open; while a new index builds, calls can receive a building note.
- **Worktree locks.** A lock left by a dead process can be taken over. Use `codegraph unlock` to remove a stale lock when no live process holds it.
- **Session focus.** Start with `codegraph serve --mcp --focus src`, and pass `scope: "repo"` to search the whole repository when needed. Out-of-focus impact results appear under `Outside focus (N)`.
- **Worktree hook.** Add `dist/extensions/host/worktree-hook/main.js` to Claude Code settings by hand, using the example in `src/extensions/host/README.md`; it sets `projectPath` to the git root of the agent's working directory.
- **Fresh answers and checkpoints.** Use `fresh: true` on an MCP call or `--fresh` on a supported CLI query; use `checkpoint: true` or `--checkpoint` for a checkpoint without waiting. `codegraph checkpoint /path/to/project` prints one and exits 3 when the index is not fresh. `CODEGRAPH_FRESH_TIMEOUT_MS` sets the freshness wait in milliseconds (default 30 seconds); `CODEGRAPH_FRESH_SETTLE_TIMEOUT_MS` bounds how long a CLI waits after printing for a still-running sync to settle before exit (default 10 minutes).
- **Extension hooks.** Add CLI commands and MCP tools in `src/extensions/<name>/extension.ts`. Set `CODEGRAPH_EXTENSION_MODULES` to comma-separated absolute module paths to load additional extensions; see `src/extensions/host/README.md` for the contract.
- **Grep.** Use `codegraph grep 'pattern' -p /path/to/project` (upstream PR #3208). Grep needs ripgrep: it runs `rg` from `PATH` unless `CODEGRAPH_RG` names another binary.
- **Blast.** Use `codegraph blast -b main -p /path/to/project` (upstream PR #3209).
- **Orphans.** Use `codegraph orphans -b main -p /path/to/project` (upstream PR #3210).
- **Suspects.** Use `codegraph suspects -p /path/to/project` (upstream PR #3207).

The four commands also have MCP tools. They are listed only when the session's `CODEGRAPH_MCP_TOOLS` names them, for example `explore,grep,blast,orphans,suspects`.

Grep counts incoming calls bound by name only separately, and blast marks dependents reached only through such calls. Use `--strict` on either command, or `strict: true` on its MCP tool, to leave those calls out of grep's counts and those dependents out of blast.

Library callers can pass `pathPrefixes: ["src/app"]` in search and context options to limit candidate lookups to whole, case-sensitive path segments relative to the index. Context graph traversal is not filtered by this option.

## Fixes carried ahead of upstream

- Node version check: [#3197](https://github.com/colbymchenry/codegraph/pull/3197).
- A file with unchanged content and a new modification time is read once, not on every sync. [#3198](https://github.com/colbymchenry/codegraph/pull/3198)
- Swift calls on standard-library values no longer link by name to a project method. [#3199](https://github.com/colbymchenry/codegraph/pull/3199)
- Swift comma-separated enum case lists index every case. [#3200](https://github.com/colbymchenry/codegraph/pull/3200)
- Swift qualified inheritance entries resolve to the types they name. [#3201](https://github.com/colbymchenry/codegraph/pull/3201)
- Rust `impl Trait for Type` inside a function body records the implementation. [#3202](https://github.com/colbymchenry/codegraph/pull/3202)
- Rust calls through a type named by a path reach that type's own function. [#3203](https://github.com/colbymchenry/codegraph/pull/3203)
- Copied indexes recover without disturbing live writers of the source index. [#3204](https://github.com/colbymchenry/codegraph/pull/3204)
- Writer and daemon ownership changes are serialized to prevent competing owners. [#3205](https://github.com/colbymchenry/codegraph/pull/3205)
- Swift static `Type.member()` calls resolve to the member declared by the type. [#3206](https://github.com/colbymchenry/codegraph/pull/3206)
- Swift calls to enum cases such as `E.bad(1)` resolve to the named enum's case, not a case from a supertype or an unrelated enum (not yet offered upstream).

## Install and set up an agent

Install Git and Node.js 22.12 or later, then build from a clone.

```sh
git clone https://github.com/codedaptive/codegraph-hub.git
cd codegraph-hub
npm ci
npm run build
node dist/bin/codegraph.js --help
```

To use `codegraph` in the shell examples, set an alias in your shell, replacing the path with the absolute path to your clone:

```sh
alias codegraph="node /absolute/path/to/codegraph-hub/dist/bin/codegraph.js"
```

Point your agent at the built file. For Claude Code, put an absolute path in a project `.mcp.json`, for example:

```json
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/codegraph-hub/dist/bin/codegraph.js", "serve", "--mcp", "--focus", "src"],
      "env": { "CODEGRAPH_MCP_TOOLS": "explore,search,callers,impact,grep,blast,orphans,suspects" }
    }
  }
}
```

`codegraph install` writes an entry using `codegraph serve --mcp`, which can run a different executable from your `PATH`; point the entry at the built file yourself. The installer does not add the focus or worktree hook.

To update a clone, run `git pull && npm ci && npm run build`. For an npm installation, `codegraph upgrade` installs the hub release GitHub marks as Latest (a release published as a pre-release is skipped) or a named hub version, using the release's packed build with `--ignore-scripts`, not upstream's registry package or install scripts. Other installation types may receive manual instructions instead; a source checkout installs nothing and may be advised to pull and rebuild. Prerelease numbers compare numerically. The update notice checks the hub's releases and uses its own cache, `update-check-hub.json`.

## Where the hub differs from upstream's defaults

- **No default project.** A call without `projectPath` gets `missing argument: root path to the code you wish to query`.
- **Indexing without opt-in.** A call can start indexing an unindexed project in the background. Set `CODEGRAPH_NO_AUTO_SEED=1` to turn this off. The builder refuses a filesystem root, a home directory, a parent of home and sensitive paths. If a session continues to query a project after `codegraph uninit`, a later call can build its index again.
- **A repository anchor.** A path outside the session's repository and its worktrees gets guidance rather than being queried. The session ignores the MCP client's `rootUri`, `workspaceFolders` and `roots/list`. `codegraph serve --mcp --path /path/to/project` sets the launch directory and anchor, not a default project.
- **Daemon command.** `codegraph daemon` reports or stops the shared server rather than offering a per-project picker.
- **Agent instructions.** The block written by `codegraph install` tells agents with the MCP tool to call `codegraph_explore` even when the project has no index, rather than skip CodeGraph.
- **Tool options.** Every MCP tool accepts optional `fresh` and `checkpoint`; search, explore and grep also accept `scope`. The default MCP tool list is `codegraph_explore` alone.

## Platforms

The hub has only been run on macOS so far. Linux and Windows are untested; worktree index copies on those platforms can use a plain copy.

Focus separates results for callers, impact and blast. It does not apply to node, callees, orphans, suspects or CLI commands. There is no access control beyond the repository anchor.

## License

The hub carries upstream's MIT license unchanged in [LICENSE](LICENSE). Copyright (c) 2026 Colby Mchenry.
