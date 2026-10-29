#!/usr/bin/env bash
# fleet/pack.sh: build a ref of the fork (default `ours`) and pack it as <base>-sm.<N>.
#
#   fleet/pack.sh <N> [ref] [out-dir]
#
# <base> is the ref's own package.json version (1.6.2 today), so the tarball is
# `colbymchenry-codegraph-1.6.2-sm.<N>.tgz` (package @colbymchenry/codegraph@1.6.2-sm.<N>). The version is
# stamped into the throwaway build copy only, never committed: an upstream version
# bump would conflict with a committed one on every daily merge.
#
# This packs the root package (dist/ built from source, run by the system Node), not
# the release bundles of scripts/pack-npm.sh: Bob's ruling (2026-10-29) is to run on
# this Mac's Node 26, never the older Node a bundle vendors.
#
# The build runs in a fresh `git archive` export under $TMPDIR, so the caller's
# worktree, its node_modules and dist/ are untouched. Prints the tarball path last.
set -euo pipefail

N="${1:?usage: fleet/pack.sh <N> [ref] [out-dir]}"
REF="${2:-ours}"
OUT="${3:-$PWD/fleet-pack-out}"
# semver forbids a leading zero in a numeric pre-release identifier (sm.01), so 0 or 1-9 then digits.
case "$N" in ''|*[!0-9]*|0?*) echo "pack: N must be a whole number with no leading zero, got '$N'" >&2; exit 2;; esac
# Made absolute now: the build below runs from the temp export, and a relative OUT would
# land inside it and be deleted with it.
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fleet-pack.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "pack: $REF = $COMMIT -> $WORK" >&2
git -C "$REPO" archive --format=tar "$COMMIT" | tar -x -C "$WORK"

cd "$WORK"
BASE="$(node -p "require('./package.json').version")"
# A base that already carries a pre-release tag would give 1.6.2-x-sm.N; refuse it.
case "$BASE" in *-*) echo "pack: $REF's version '$BASE' is already a pre-release" >&2; exit 2;; esac
VERSION="$BASE-sm.$N"

# --ignore-scripts: no install script of the tree is needed to build; ui/ is an npm
# workspace, so this one `npm ci` installs it too. DO_NOT_TRACK: telemetry is off here.
export DO_NOT_TRACK=1
npm ci --ignore-scripts --no-audit --no-fund >&2
npm run build >&2

# Stamp the version in the export only (no git, no lockfile commit: --no-git-tag-version).
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
TARBALL="$(npm pack --pack-destination "$OUT" --silent)"
# Record what was packed beside the tarball, so an install can be traced to its commit.
printf 'version=%s\nref=%s\ncommit=%s\npacked=%s\nnode=%s\n' \
  "$VERSION" "$REF" "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(node --version)" \
  > "$OUT/${TARBALL%.tgz}.txt"
echo "$OUT/$TARBALL"
