<img src="docs/assets/codegraph-hub-hero.jpg" alt="CodeGraph-Hub: a centralized knowledge graph and repository analysis platform. Intelligence and analysis." width="100%">

<div align="center">

# CodeGraph Hub — Codedaptive

A fork of [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph), optimized for use with
**[CodeTeam - CE](https://github.com/codedaptive/codeteam-ce)**.

### One code graph server for every agent on your machine.

**One server. Every worktree. The right checkout on every call.**

[![Upstream baseline](https://img.shields.io/badge/upstream-v1.6.3-blue)](https://github.com/colbymchenry/codegraph/tree/v1.6.3)
[![Platforms](https://img.shields.io/badge/platforms-macOS-blue)](#platforms)
[![License: MIT](https://img.shields.io/badge/license-MIT-success)](LICENSE)

[Install](#install-and-set-up-an-agent) · [Works with](#works-with) · [How to use it](#how-to-use-it) · [Issues](https://github.com/codedaptive/codegraph-hub/issues)

</div>

CodeTeam - CE is optional: this fork also works with other compatible clients and
agent workflows.

CodeGraph Hub is a fork of [CodeGraph](https://github.com/colbymchenry/codegraph) built for running many AI coding agents at once. Every session on your machine shares one server, agents can each query their own checkout, and the index keeps up as parallel work moves.

The hub tracks colbymchenry/codegraph and keeps its own feature set. It is brought up to date once a month. It takes issues through GitHub Issues in this repository; an issue that needs a fix sooner gets one out of cycle. `main` is the stable branch and every release is cut from it; `develop` carries work before it reaches `main` and may be rewritten, so don't base work on it.

## What it does

- **One shared server.** A single machine-wide server replaces the daemon per project, and idle project indexes close on their own.
- **The right code on every call.** Each MCP call names its repository or worktree, so parallel agents can stay on their own checkouts.
- **Worktrees that start ready.** A new worktree can copy the nearest sibling's index, and removed worktrees are cleaned up.
- **Orderly index builds.** A separate builder queues index writes, one queue per repository, so agents don't compete to update the same index. Each build runs in its own process under a time and memory limit.
- **Answers you can verify.** Agents can wait for an up-to-date index or get a checkpoint of the indexed state.
- **Sessions that keep working.** If the shared server can't be reached, a session answers from existing indexes in read-only mode.
- **Focused searches.** A session focus narrows finding tools to the part of the repository you're working in.
- **Change review tools.** `grep` finds text and groups each hit under the symbol that contains it, `blast` shows what depends on the lines a change touched, `orphans` lists what a branch added that nothing uses, and `suspects` lists the call edges that need a second look.
- **Indexing you control.** Git worktrees are indexed; a folder outside git is indexed only once you opt it in. A `.codegraphignore` file keeps paths out of the index, and a symlinked folder that leaves the project is skipped unless you include it.
- **More of your code in the graph.** Scripts with no file extension are indexed in the language their `#!` line names, and a Python file that loads another by path is linked to it.
- **Runs on Node 25 and later.** Upstream's CLI refuses to start on Node 25; its `engines` field (`>=20.0.0 <25.0.0`) only warns.
- **Fixes ahead of upstream.** The hub carries fixes for Swift, Rust and TypeScript resolution and parsing, index recovery, stale-lock takeover, and syncs that re-read unchanged files.

For everything else CodeGraph does, see [upstream's README](UPSTREAM-README.md).

## Works with

These Codedaptive projects complement the hub on the agent side:

- **[CodeTeam - CE](https://github.com/codedaptive/codeteam-ce)** runs a coordinated
  team of coding agents. Its agents can share the hub's one server across all of the
  team's worktrees, with a focus per part of the code and the worktree hook so each
  agent queries its own checkout.
- **[MOOTx01 CE](https://github.com/codedaptive/mootx01-ce)** gives agents persistent
  memory across sessions, models, and machines.

For model access, the three CLIProxy repositories form one stack. Each has a separate
job and can be updated independently:

| Project | What it does |
| --- | --- |
| **[CLIProxyAPI](https://github.com/codedaptive/CLIProxyAPI)** | Serves model APIs, connects provider accounts, and loads native plugins. |
| **[CLIProxyAPI-QuotaRouter](https://github.com/codedaptive/CLIProxyAPI-QuotaRouter)** | Selects accounts by quota/reset policy, keeps desktop sessions attached, and routes model/effort roles. |
| **[CLIProxyAPI-MgmtCenterWithForecasting](https://github.com/codedaptive/CLIProxyAPI-MgmtCenterWithForecasting)** | Manages the proxy and adds usage history, spend analysis, quota forecasts, and subscription planning. |

MOOTx01 and the CLIProxy stack connect to the agents through their own integrations;
they are optional and are not installed by the hub.

## How to use it

The examples use `codegraph` for the built CLI; see the setup section to run it from a clone.

- **Server controls.** Use `codegraph daemon` to see the server and `codegraph daemon --stop` to stop it, and set `CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS` (default ten minutes), `CODEGRAPH_STATE_DIR` (an absolute path), `CODEGRAPH_HOUSEKEEPING_INTERVAL_MS` (default 60 seconds; `0` turns it off) or `CODEGRAPH_SERVER_STOP_GRACE_MS` (default 15 seconds) to change the idle timeout, the state directory, the cleanup interval or how long a stopping server waits for its sessions.
- **Project controls.** Use `codegraph project list --json`, `codegraph project seed /path/to/worktree` (copies an index from the nearest sibling worktree that has one; exit 0 indexed, 3 no sibling has one, 1 failed), `codegraph project pin /path/to/project` (keeps it open, seeding a worktree with no index first), `codegraph project unpin /path/to/project` and `codegraph project remove /path/to/project` (deletes no files).
- **Folders outside git.** Opt a folder in once with `codegraph init /path/to/folder --no-git`, after which it is indexed like a worktree but never seeded or built automatically, and `codegraph uninit` removes its index and its opt-in.
- **Ignore file.** Put a `.codegraphignore` in `.gitignore` syntax at the project root to keep paths out of the index without changing what git tracks, for example `generated/`, and use a negation such as `!vendor/shared` to re-include a path, including a symlinked folder that points outside the project.
- **Scripts without an extension.** A file with no extension whose `#!` line names Python, Node, Bun, Deno, ts-node, tsx, Ruby, PHP, Lua, Rscript or Swift is indexed in that language, for example `bin/tool` starting with `#!/usr/bin/env python3`, with nothing to set.
- **Python files loaded by path.** A Python file that loads another with `importlib`'s `SourceFileLoader(name, path)` or `spec_from_file_location(name, path)` gets an import link to it, so `codegraph affected` names the file that loads it, with nothing to set.
- **Fallback.** While serving in process, the session normally retries the server and never builds or syncs an index, even for `fresh: true`.
- **Query workers.** Spare query workers retire after `CODEGRAPH_QUERY_WORKER_IDLE_TIMEOUT_MS` of idle time (default 60 seconds; `0` turns it off), while the last worker keeps upstream's five-minute idle trim.
- **Project path.** Pass `projectPath: "/path/to/project"` on an MCP call.
- **Builder.** Each repository has its own builder queue, with its syncs ahead of its full builds, and `CODEGRAPH_BUILDER_ENSURE_WAIT_MS` (default 10 seconds) bounds how long a call waits for the builder to open an index.
- **Builder limits.** A build or sync that runs longer than `CODEGRAPH_BUILDER_JOB_MAX_MS` (default 3600000, one hour) or holds more memory than `CODEGRAPH_BUILDER_JOB_MAX_RSS_MB` (default 8192), as set where the server starts, is stopped and not retried until you run `codegraph index /path/to/project`, and answers from that project name the limit meanwhile.
- **Disk space.** When a build or sync leaves more than a quarter of an index file free and at least 256 MiB, the builder compacts that index if free disk is more than twice its size, with nothing to set.
- **Worktree locks.** A lock left by a dead process can be taken over, and `codegraph unlock` removes a stale lock no live process holds.
- **Session focus.** Start with `codegraph serve --mcp --focus src` and pass `scope: "repo"` to search the whole repository, while impact results outside the focus appear under `Outside focus (N)`.
- **Worktree hook.** Add the hook shown under [Install and set up an agent](#install-and-set-up-an-agent) to Claude Code's settings, and it sets each codegraph MCP call's `projectPath` to the git root of the agent's working directory.
- **Fresh answers and checkpoints.** Use `fresh: true` on an MCP call or `--fresh` on `query`, `explore`, `node`, `callers`, `callees`, `impact` or `checkpoint` to wait for the index first (up to `CODEGRAPH_FRESH_TIMEOUT_MS`, default 30 seconds, with a CLI's sync still running at that bound waited for after printing, before exit, up to `CODEGRAPH_FRESH_SETTLE_TIMEOUT_MS`, default 10 minutes), or `checkpoint: true` or `--checkpoint` for a checkpoint without waiting, and `codegraph checkpoint /path/to/project` exits 3 when the index is not fresh.
- **Extension hooks.** Add CLI commands and MCP tools with a module that exports `name` (and optionally `registerCommands(program)` and `tools`) as its default in `src/extensions/<name>/extension.ts`, which the built CLI loads from `dist/extensions/<name>/extension.js`, or list more compiled modules by absolute path, comma-separated, in `CODEGRAPH_EXTENSION_MODULES`.
- **Grep.** Use `codegraph grep 'pattern' -p /path/to/project` (upstream PR #3208), with `--in src/db` to search under one folder and `--json` for JSON; it needs ripgrep, `rg` from `PATH` or the binary `CODEGRAPH_RG` names.
- **Blast.** Use `codegraph blast -b main -p /path/to/project` (upstream PR #3209); without `-b` it compares the uncommitted changes with `HEAD`, or the last commit when the tree is clean, and `-f json` or `-f markdown` changes the output.
- **Orphans.** Use `codegraph orphans -b main -p /path/to/project` (upstream PR #3210; `-b` is required) to list what was added from the merge base to the working tree, uncommitted edits to tracked files included, that nothing uses, with `--json` for JSON.
- **Suspects.** Use `codegraph suspects -p /path/to/project` (upstream PR #3207); `--json` prints `{ version: 1, suspects }` as JSON.

The four commands also have MCP tools. They are listed only when the session's `CODEGRAPH_MCP_TOOLS` names them, for example `explore,grep,blast,orphans,suspects`.

Grep counts incoming calls bound by name only separately, and blast marks dependents reached only through such calls. Use `--strict` on either command, or `strict: true` on its MCP tool, to leave those calls out of grep's counts and those dependents out of blast.

Library callers can pass `pathPrefixes: ["src/app"]` in search and context options to limit candidate lookups to whole, case-sensitive path segments relative to the index. Context graph traversal is not filtered by this option.

## Fixes carried ahead of upstream

- Runs on Node 25 and later. [#3197](https://github.com/colbymchenry/codegraph/pull/3197)
- A file with unchanged content and a new modification time is read once, not on every sync. [#3198](https://github.com/colbymchenry/codegraph/pull/3198)
- Swift calls on standard-library values no longer link by name to a project method. [#3199](https://github.com/colbymchenry/codegraph/pull/3199)
- Swift comma-separated enum case lists index every case. [#3200](https://github.com/colbymchenry/codegraph/pull/3200)
- Swift qualified inheritance entries resolve to the types they name. [#3201](https://github.com/colbymchenry/codegraph/pull/3201)
- Rust `impl Trait for Type` inside a function body records the implementation. [#3202](https://github.com/colbymchenry/codegraph/pull/3202)
- Rust calls through a type named by a path reach that type's own function. [#3203](https://github.com/colbymchenry/codegraph/pull/3203)
- Copied indexes recover without disturbing live writers of the source index. [#3204](https://github.com/colbymchenry/codegraph/pull/3204)
- Swift static `Type.member()` calls resolve to the member declared by the type. [#3206](https://github.com/colbymchenry/codegraph/pull/3206)
- TypeScript variance annotations (`<in T>`, `<out T>`, `<in out T>`) parse. [#3226](https://github.com/colbymchenry/codegraph/pull/3226)
- Callback and function-pointer dispatch passes skip files and fields no registration can match. [#3258](https://github.com/colbymchenry/codegraph/pull/3258)
- After a definition changes, a sync rebinds every caller that matched it by a common name. [#3261](https://github.com/colbymchenry/codegraph/pull/3261)
- Grammar loads started together wait for one another. [#3303](https://github.com/colbymchenry/codegraph/pull/3303)
- A `.codegraphignore` file keeps paths out of the index without changing what git tracks. [#3329](https://github.com/colbymchenry/codegraph/pull/3329)

Also in the hub, not yet offered upstream: Swift calls to enum cases such as `E.bad(1)` resolve to the named enum's case, not a case from a supertype or an unrelated enum; a Swift type's supertypes are read from its own declaration, not from a nested type's inheritance clause (upstream issue [#3213](https://github.com/colbymchenry/codegraph/issues/3213)); a Swift member is matched to the supertype or protocol declaration it was reached through; a Rust path call whose first segment a `use` binds resolves through the nearest binding, an inner `use` before an outer block `mod` of the same name; and on macOS a newly watched project's file watcher counts as ready only once an event for a probe file it touches arrives or 5 seconds pass, or at once, without that proof, when the probe file cannot be created.

The hub also removes a stale lock only if it is still the file the taker judged stale.

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

Or install a release's packed build with npm, naming the version from the [releases page](https://github.com/codedaptive/codegraph-hub/releases). `--ignore-scripts` keeps the package's uninstall script from removing other installs' agent entries:

```sh
npm install -g --ignore-scripts https://github.com/codedaptive/codegraph-hub/releases/download/v1.6.3-sm.18/colbymchenry-codegraph-1.6.3-sm.18.tgz
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

To have every codegraph MCP call query the agent's own worktree, add the worktree hook to Claude Code's `settings.json`, with the absolute path to the built file:

```json
{"hooks":{"PreToolUse":[{"matcher":"mcp__codegraph__.*","hooks":[{"type":"command","command":"node /absolute/path/to/codegraph-hub/dist/extensions/host/worktree-hook/main.js"}]}]}}
```

The matcher names the MCP server key `codegraph`. The hook replaces any `projectPath` with the git root of the agent's working directory and allows the call without a permission prompt; outside a git repository it does nothing.

`codegraph install` writes an entry using `codegraph serve --mcp`, which can run a different executable from your `PATH`; point the entry at the built file yourself. The installer does not add the focus or worktree hook.

To update a clone, run `git pull && npm ci && npm run build`. For an npm installation, `codegraph upgrade` installs the hub release GitHub marks as Latest (a release published as a pre-release is skipped) or a named hub version, using the release's packed build with `--ignore-scripts`, not upstream's registry package or install scripts. It refuses a target that is not a whole version such as `1.6.3` or `v1.6.3-sm.18`. Other installation types may receive manual instructions instead; a source checkout installs nothing and may be advised to pull and rebuild. Prerelease numbers compare numerically. The update notice checks the hub's releases and uses its own cache, `update-check-hub.json`.

## Running the tests

Run `npm ci` once first. `npx vitest run` runs the unit group, the default; set `CODEGRAPH_TEST_GROUP` to `unit`, `integration`, `validation` or `all` to choose, for example `CODEGRAPH_TEST_GROUP=all npx vitest run` for every group. The test setup builds `dist/` itself when it is missing or out of date, so `npm run build` is not needed first.

A test file ending in `.integration.test.ts` or `.gate.test.ts` is in the integration group and one ending in `.validation.test.ts` in the validation group; `test-groups.json` places other files by path, and every other test is a unit test. The sorting lives in `test-groups.mts`, which `vitest.config.mts` loads.

## Where the hub differs from upstream's defaults

- **No default project.** A call without `projectPath` gets `missing argument: root path to the code you wish to query`.
- **Git worktrees only, unless opted in.** The hub indexes git worktrees and the folders opted in with `codegraph init <dir> --no-git`. `init`, `index` and `sync` on a folder inside a worktree act on the worktree's root. CLI read commands (`status`, `query`, `explore`, `node`, `callers`, `grep`, `blast` and the rest) refuse any other path with exit 1, and an MCP call there is answered that the path is not in a git repository.
- **Indexing without opt-in.** A call on a git worktree with no index can start indexing it in the background, by copying a sibling's index or building one. Set `CODEGRAPH_NO_AUTO_SEED=1` to turn this off. The builder refuses a filesystem root, a home directory, a parent of home and sensitive paths. If a session continues to query a worktree after `codegraph uninit`, a later call can build its index again.
- **Symlinked folders.** A symlinked folder whose target is outside the project is skipped by the scan and the watcher unless `.codegraphignore` re-includes it.
- **A repository anchor.** A path outside the session's repository and its worktrees gets guidance rather than being queried. The session ignores the MCP client's `rootUri`, `workspaceFolders` and `roots/list`. `codegraph serve --mcp --path /path/to/project` sets the launch directory and anchor, not a default project.
- **Daemon command.** `codegraph daemon` reports or stops the shared server rather than offering a per-project picker.
- **Prompt hook.** The hidden `prompt-hook` command reads the index in its own process; upstream's route for it through a per-project daemon is not included.
- **Agent instructions.** The block written by `codegraph install` tells agents with the MCP tool to call `codegraph_explore` even when the project has no index, rather than skip CodeGraph.
- **Tool options.** Every MCP tool accepts optional `fresh` and `checkpoint`; search, explore and grep, which a session focus narrows, also accept `scope`. The default MCP tool list is `codegraph_explore` alone.

## Platforms

The hub has only been run on macOS so far. Linux and Windows are untested; worktree index copies on those platforms can use a plain copy.

Focus narrows search, explore and grep, and separates results for callers, impact and blast. It does not apply to node, callees, orphans, suspects or CLI commands. There is no access control beyond the repository anchor.

## License

The hub carries upstream's MIT license unchanged in [LICENSE](LICENSE). Copyright (c) 2026 Colby Mchenry.
