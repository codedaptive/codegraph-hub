# Rulings register

Bob's rulings, numbered R-1, R-2, ... and never renumbered. Recorded by Designer-Codegraph and posted to
General as a RULING line. Decisions already settled by a document live in `team/settled.md` (S-n).

## R-1. Go-ahead for the global install of 1.6.2-sm.2
- Date: 2026-10-29 22:20 / Bob
- Ruling: install the packed 1.6.2-sm.2 tarball (`releases/`, ours 11b39cfc) globally, replacing sm.1 at /opt/homebrew/bin/codegraph.
- Work implied: Orc-Codegraph installs it and confirms the version and the 10 MCP tools from the installed binary.

## R-2. Telemetry off
- Date: 2026-10-29 22:20 / Bob
- Ruling: turn CodeGraph telemetry off for the global install (`codegraph telemetry off`), in addition to `DO_NOT_TRACK=1`.
- Work implied: Orc-Codegraph runs it after R-1 and confirms the setting.
