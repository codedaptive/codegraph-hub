#!/bin/bash
# run.sh <outfile-stem> <manifest> -- graft args...
# Runs one graft command in the clone, saving stdout to <stem>, stderr to <stem>.stderr,
# and a TSV manifest line: id, commit, load-before, real, user, sys, exit, command.
set -u
stem=$1; man=$2; shift 3
export DO_NOT_TRACK=1
commit=$(git rev-parse HEAD)
load=$(sysctl -n vm.loadavg | tr -d '{}' | xargs)
tf=$(mktemp)
/usr/bin/time -p -o "$tf" graft "$@" > "$stem" 2> "$stem.stderr"
rc=$?
real=$(awk '/^real/{print $2}' "$tf"); user=$(awk '/^user/{print $2}' "$tf"); sys=$(awk '/^sys/{print $2}' "$tf")
rm -f "$tf"
[ -s "$stem.stderr" ] || rm -f "$stem.stderr"
cmd=$(printf '%q ' graft "$@")
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(basename "$stem")" "$commit" "$load" "$real" "$user" "$sys" "$rc" "${cmd% }" >> "$man"
