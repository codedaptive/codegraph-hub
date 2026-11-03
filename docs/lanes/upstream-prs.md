# Upstream PRs zone guide

The upstream-prs lane (Coord-upstream-prs; Bob's ruling R-26) owns our pull requests to
`colbymchenry/codegraph` and the analysis of new upstream commits. It owns `docs/upstream` and works in
`workcrews/upstream-prs/` (the `_base` checkout and its branches, the `texts/` PR bodies, `BRIEF-*.md`).

## What the lane does
- Cuts `pr/<feature>` branches from upstream, cherry-picks each feature's squashes, restacks a stack when a parent
  changes (proved by tree equality or patch-id equality, never a follow-up commit), pushes to the fork
  (`codedaptive/codegraph-sharedserver`), and keeps each PR's body and replies current.
- A code change inside a PR is a REQUEST to the lane that owns that code (host, queries, resolution); that lane
  commits it, and upstream-prs stacks the commit.
- Reads each new upstream commit and reports to Orc-Codegraph what to pull down and what conflicts with ours and with
  the open PRs. The daily merge of upstream into ours, through integration, stays Orc-Codegraph's.

## Rules that bind the work
- One squash per feature on a pushed PR; public commits carry the PR's own message and no `Co-Authored-By`, `Feature:`
  or tool trailers. PR texts and replies read as written by a stranger to this team (no Makefile, restack or lane
  wording); a leak scan runs before every push and body edit.
- R-24: after round two there are no fixes or replies for comments the round-two pushes draw. R-25: no comment asking
  the maintainer for anything. R-21: macOS only. R-22: only changed tests run. R-18: the installed CodeGraph is never
  replaced without Bob.
- A fix made on a PR is also a fix to `ours` where `ours` has the defect (`product.md`: ours is what we ship, each
  feature can be cherry-picked onto upstream); the owning lane ports it with the PR's failing-first test.

## Starting point
The hand-over of the open PRs (#3197 to #3210: heads, stack order, scripts, open items) is in Orc-Codegraph's ledger,
`reports/handover-upstream-prs.md`, with the per-PR results in `reports/r17-round2-results.md` beside it.
