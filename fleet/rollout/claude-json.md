# ~/.claude.json: the stale global codegraph entry removed

Shared state: `/Users/bob/.claude.json`, user scope. For Bob's go-ahead; the lane never applies it.

## Today (checked 2026-10-29)

The user-scope `mcpServers` holds one server, and no project in `projects` has its own `codegraph` entry:

```json
"mcpServers": { "codegraph": { "type": "stdio", "command": "codegraph", "args": ["serve", "--mcp"] } }
```

It was written by 1.5.0's `codegraph install` and carries none of the env the fleet needs (no `DO_NOT_TRACK`, the
query pool on, the default one-tool list). Isolated codeteam sessions never see it (`--strict-mcp-config`); every
other Claude Code session on this Mac gets it, beside `codeteam/mcp.json`'s entry of the same name.

## Apply

Claude Code rewrites this file while it runs, so edit it through its own CLI, not by hand:

```bash
claude mcp remove codegraph -s user
claude mcp list            # codegraph no longer listed from user scope
```

## Undo

```bash
claude mcp add codegraph -s user -- codegraph serve --mcp
```

(`claude mcp add` writes `"type": "stdio"` for a command server, which restores the entry as it was.)
