# graft 0.16 golden files

graft's own output, saved before graft is retired, as the reference the CodeGraph `grep-by-symbol` (MISSION WP3)
and `blast-base` (WP4) features are checked against. Fleet-only; never offered upstream. Recorded 2026-10-29.

## Source

- Repo: mootx01-ee (`/Users/bob/devlop/.repos/mootx01-ee.git`), a throwaway `git clone --shared`, deleted afterwards.
- grep: every run at the pinned commit `96acd65de890993aeeafa18ee4a46e1d7b87dade` (2026-10-28 23:45).
- blast: each run with HEAD detached at its own commit X and `--base X^` (ruling S-1, Orc-Codegraph 2026-10-29),
  because `--base` diffs merge-base..HEAD. graft refreshed its graph from the pinned build before the first run at
  each commit; that refresh is in the first run's time and in its `.json.stderr`.
- graft 0.16.0 (`/opt/homebrew/bin/graft`), **patched** by Bob on 2026-10-28: `dist/search/grep.js` `symbolsOf`
  indexes nodes by path once (`/Users/bob/graftlab/grep-symbolsOf-index.patch`, sha256 `c15caebe…ceb7`; installed
  grep.js sha256 `33c47443…edd2`, original `17b1a0ae…cb64`). Output was verified identical to the unpatched file.
- Graph: one cold `graft build .` at the pinned commit: 5,478 files, 101,460 nodes, 221,919 edges, languages
  c, c_sharp, go, javascript, python, rust, swift. 706.6 s wall, 114.6 s user, 7.0 s sys, peak 7.5 GB; load 37.3 at
  the start, 80.1 at the end.
- Machine: Apple M5 Max, 18 cores, macOS 27.2, Node v26.12.0, `DO_NOT_TRACK=1`. The machine was overloaded throughout
  (load 17–38 during the runs); the times are from an overloaded machine, not a benchmark.

## Files

`runs.tsv` in each folder has one line per file: the file, the commit it ran at, the load (1/5/15 min) just before,
wall/user/sys seconds, the exit code, and the exact command (shell-quoted). A `<file>.stderr` holds graft's stderr when
it wrote any (the no-hits hint, or the refresh line). Text output ends with graft's "tokens saved" line, as graft
prints it.

### grep/ (10 patterns, each as `<id>.json` from `--json` and `<id>.txt` as text)

All patterns are commands team-moot agents ran (from their Claude Code transcripts).

| id | command | covers |
|---|---|---|
| g01-unscoped-many | `graft grep temp_dir` | unscoped, many hits (209 in 197 symbols) |
| g02-scoped | `graft grep EstateFormatStore --in packages/kits/GeniusLocusKit` | `--in`-scoped, many hits |
| g03-fixed-scoped | `graft grep --fixed EstateOpening::REGISTERED --in packages/kits/AriaMcpKit` | `--fixed` and scoped |
| g04-fixed-unscoped | `graft grep --fixed 'remap(verb:'` | `--fixed` with regex metacharacters |
| g05-ignorecase-unscoped | `graft grep -i backfill` | `-i`, unscoped |
| g06-ignorecase-scoped | `graft grep -i backfill --in packages/kits/ConvergenceKit` | `-i`, scoped |
| g07-regex-scoped | `graft grep 'K-[0-9]+\|R-[0-9]+\|CR-[0-9]+' --in packages/kits/SynapseKit/rust` | regex alternation |
| g08-outside-symbols | ``graft grep '//!\|```' --in packages/kits/ConvergenceKit/rust/`` | hits outside any symbol ("module level") |
| g09-name-many-hits | `graft grep Timestamp` | a name with many hits; graft stops at 300 (`truncated`) |
| g10-corpuskit-scoped | `graft grep decodeRowHLC --in packages/kits/CorpusKit` | a CorpusKit symbol |

(`\|` in the table is a Markdown escape; the pattern is `K-[0-9]+|R-[0-9]+|CR-[0-9]+`.) `sqlite_open_v2`, the most-run
pattern in the transcripts, has no hits at the pinned commit and was replaced by g01/g02.

### blast/ (5 CorpusKit commits, each as `<id>.json` from `--format json` and `<id>.txt` as text, default depth 2)

| id | commit | diff | refresh before first run |
|---|---|---|---|
| b01 | `1b3de70f45` | 7 files, all CorpusKit | 5,674 files |
| b02 | `ddf309d619` | 34 files, 13 CorpusKit | 979 files |
| b03 | `20eedf224f` | 6 files, 2 CorpusKit; also `-d all` (`b03-…-depth-all.*`) | 1,606 files |
| b04 | `101836517c` | 51 files, 11 CorpusKit | 134 files |
| b05 | `e07bbddd03` | 8 files, 1 CorpusKit | 124 files |

The output includes graft's "who to tag" suggestions (git-history owners, on by default), which WP4 leaves out.

## Reproduce

```bash
git clone --shared --no-checkout /Users/bob/devlop/.repos/mootx01-ee.git mootx01-ee && cd mootx01-ee
git checkout --detach 96acd65de890993aeeafa18ee4a46e1d7b87dade
DO_NOT_TRACK=1 graft build .
# grep, at the pinned commit (run.sh appends a line to the manifest it is given):
<path>/run.sh out/g01-unscoped-many.json out/runs.tsv -- grep --json temp_dir
# blast, per commit X:
git checkout --detach X && <path>/run.sh out/bNN-X.json out/runs.tsv -- blast --base 'X^' --format json
```

`run.sh` is the script that made these files. The exact argument lists are in each `runs.tsv`.
