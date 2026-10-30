#!/usr/bin/env bash
# fleet/baselines/run-baseline.sh <codegraph-bin> <source-repo> <ref> <name> <work-dir>
#
# One repository's CodeGraph baseline, on a throwaway clone made here and deleted at the end:
#   - cold index (`codegraph init`): wall, user, sys, peak RSS (BSD /usr/bin/time -l), load before and after;
#   - index size (codegraph.db + -wal, MiB), files per language, nodes, edges;
#   - `callers`, `query` (the CLI's search) and `impact` (depth 2) on the function or method with the most
#     incoming `calls` edges, each a fresh CLI process, so process start-up is included;
#   - a one-file sync: one blank line appended to a file of the repo's main language, `codegraph sync` timed.
# Prints `key<TAB>value` lines to stdout (the report is assembled from them). DO_NOT_TRACK is forced on.
set -euo pipefail
BIN="${1:?usage}"; SRC="${2:?usage}"; REF="${3:?usage}"; NAME="${4:?usage}"; WORK="${5:?usage}"
# NAME becomes a folder under WORK that is deleted on exit: one plain path component only.
case "$NAME" in ""|.|..|*/*) echo "run-baseline: name must be one path component, got '$NAME'" >&2; exit 2;; esac
export DO_NOT_TRACK=1
mkdir -p "$WORK"
W="$WORK/$NAME"
rm -rf "$W"
trap 'rm -rf "$W"' EXIT
git clone -q --no-checkout "$SRC" "$W"
# REF is a commit, a tag, or a branch of the source (in the clone: origin/<branch>).
C="$(git -C "$W" rev-parse -q --verify "$REF^{commit}" || git -C "$W" rev-parse -q --verify "origin/$REF^{commit}")"
git -C "$W" -c advice.detachedHead=false checkout -q --detach "$C"
out() { printf '%s\t%s\n' "$1" "$2"; }
out repo "$NAME"; out source "$SRC"; out ref "$REF"; out commit "$(git -C "$W" rev-parse HEAD)"
out tracked_files "$(git -C "$W" ls-files | wc -l | tr -d ' ')"
out codegraph "$("$BIN" --version)"; out node "$(node --version)"

# t <label> <cmd...>: run once under /usr/bin/time -l and report wall, user, sys and peak RSS.
t() {
  local label=$1; shift
  local tf; tf="$(mktemp)"
  /usr/bin/time -l -o "$tf" "$@" > /dev/null 2>&1 || { out "${label}_exit" "$?"; }
  out "${label}_wall_s" "$(awk '/ real /{print $1}' "$tf")"
  out "${label}_user_s" "$(awk '/ real /{print $3}' "$tf")"
  out "${label}_sys_s"  "$(awk '/ real /{print $5}' "$tf")"
  out "${label}_rss_mb" "$(awk '/maximum resident set size/{printf "%.0f", $1/1048576}' "$tf")"
  rm -f "$tf"
}

out load_before "$(sysctl -n vm.loadavg | tr -d '{}' | xargs)"
t init "$BIN" init "$W"
out load_after "$(sysctl -n vm.loadavg | tr -d '{}' | xargs)"

DB="$W/.codegraph/codegraph.db"
# Not -readonly: a WAL database needs its -shm written even to read.
q() { sqlite3 "$DB" "$1"; }
out db_mb "$(awk -v a="$(stat -f %z "$DB")" -v b="$( [ -f "$DB-wal" ] && stat -f %z "$DB-wal" || echo 0)" 'BEGIN{printf "%.1f", (a+b)/1048576}')"
out indexed_files "$(q 'select count(*) from files;')"
out nodes "$(q 'select count(*) from nodes;')"
out edges "$(q 'select count(*) from edges;')"
out languages "$(q "select group_concat(language || ' ' || c, ', ') from (select language, count(*) c from files group by language order by c desc);")"

# The most-called function or method: the usual subject of a "who calls this" question.
SYM="$(q "select n.name from edges e join nodes n on n.id = e.target where e.kind = 'calls' and n.kind in ('function','method') group by n.id order by count(*) desc, n.name limit 1;")"
out symbol "$SYM"
if [ -n "$SYM" ]; then
  out symbol_callers "$(q "select count(*) from edges e join nodes n on n.id = e.target where e.kind = 'calls' and n.name = '$(printf %s "$SYM" | sed "s/'/''/g")';")"
  t callers "$BIN" callers "$SYM" -p "$W"
  t query   "$BIN" query "$SYM" -p "$W"
  t impact  "$BIN" impact "$SYM" -p "$W"
fi

# One-file sync on a file of the main language. The edit is never undone: the clone is deleted on exit.
LANG1="$(q "select language from files group by language order by count(*) desc limit 1;")"
F="$(q "select path from files where language = '$LANG1' order by path limit 1;")"
out sync_file "${F:-none (no source file indexed)}"
if [ -n "$F" ]; then
  printf '\n' >> "$W/$F"
  t sync "$BIN" sync "$W"
fi
