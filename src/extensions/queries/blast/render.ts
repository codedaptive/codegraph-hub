/**
 * Renderers for a `BlastReport`: terminal text, a PR-comment markdown body, and JSON.
 *
 * The text report has no "who to tag" block because it computes no reviewers.
 * The markdown report has a headline, test line, impact table, collapsed
 * sections and caveats. The collapsed symbol list's "…N further symbols not
 * listed" counts omitted rows even when the 60-row cap falls inside an area's
 * list, and is omitted when none were, including when exactly 60 are listed.
 *
 * The report omits a diagram, tag line, owner section and per-symbol evidence
 * snippets. The markdown header is "### blast radius" and the footer names
 * `codegraph blast`.
 *
 * A dependent marked `questionable`
 * says so on its line in text and markdown, and one caveat line counts the
 * marked dependents. A report with no marks renders no questionable text.
 *
 * Under a session focus (`report.outsideFocus`, set by `splitReportByFocus` in
 * `./focus.ts`) `modules` holds only the dependents inside it, so the headline,
 * the impact table and the "All N dependent symbols" list count those alone. The
 * test signal and the test-suite sections are not split. The "Outside focus"
 * section prints only when it has dependents: in text after the in-focus module
 * blocks, in markdown after the collapsed sections and before the caveats. json
 * is the report itself, `outsideFocus` included. A report with no `outsideFocus`
 * (the CLI, an unfocused session) has no focus section.
 */
import { outsideFocusHeading } from '../shared/focus';
import type { BlastReport, Module } from './blast';

/** Table rows under the headline; the rest fold into one "smaller areas" row. */
const MAX_TABLE_ROWS = 6;
/** Symbols listed in the collapsed list of every dependent. */
const MAX_SYMBOLS_LISTED = 60;
/** Symbols listed per module in the text report before a "…N more" line. */
const MAX_TEXT_SYMBOLS = 25;
/** Unreached seed names listed per area in the test signal before a "…N more". */
const MAX_UNREACHED_LISTED = 8;
/** Test suite files listed in the collapsed test-suite section before a "…N more" line. */
const MAX_TEST_FILES_LISTED = 20;
/** Deleted or unindexed paths named in a caveat line. */
const MAX_CAVEAT_PATHS = 5;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function depthLabel(depth: number): string {
  return Number.isFinite(depth) ? `depth ${depth}` : 'full closure';
}

/** The glyph carried per area test state. */
const TEST_GLYPH: Record<'changed' | 'stale' | 'none' | 'na', string> = { changed: '✓', stale: '⚠', none: '✗', na: '–' };

/**
 * JSON report: hunk lines carry only their number and sign, not their text. The
 * lines are cut in a copy; the report given is not changed. Ranges and hunks
 * keep `deletion: true` for pure deletions. `depth: Infinity` serializes as
 * null, representing the full closure.
 */
export function jsonReport(r: BlastReport): string {
  return JSON.stringify({
    ...r,
    changed: r.changed.map((f) => ({
      ...f,
      hunks: f.hunks.map((h) => ({ ...h, lines: h.lines.map(({ n, sign }) => ({ n, sign })) })),
    })),
  }, null, 2);
}

/** The PR-comment body: headline, test line, one table, then the collapsed sections; under a focus, an uncollapsed `## Outside focus (N)` section, then the caveat lines. */
export function markdownReport(r: BlastReport): string {
  const out: string[] = [];
  const symbols = r.modules.reduce((n, m) => n + m.symbols.length, 0);
  out.push('### blast radius');
  out.push('');
  out.push(headline(r, symbols));
  const testLine = testHeadline(r);
  if (testLine) out.push(testLine);
  if (symbols > 0) {
    out.push('');
    out.push(...impactTable(r));
  }
  out.push('');
  out.push(...detailSections(r, symbols));
  const outside = r.outsideFocus;
  if (outside && outside.count > 0) {
    out.push('');
    out.push(outsideFocusHeading(outside.count));
    out.push('');
    out.push(...symbolList(outside.modules, outside.count));
    // symbolList ends each module with a blank line; the one below separates the next block.
    out.pop();
  }
  const caveats = caveatLines(r);
  if (caveats.length > 0) {
    out.push('');
    for (const line of caveats) out.push(line);
  }
  out.push('');
  out.push(`<sub>\`codegraph blast\` · ${r.basis} · ${depthLabel(r.depth)} · ${plural(r.changed.length, 'changed file')}</sub>`);
  return out.join('\n') + '\n';
}

function headline(r: BlastReport, symbols: number): string {
  const areas = plural(r.areas.length, 'area');
  const outside = r.outsideFocus;
  if (symbols === 0 && outside && outside.count > 0) {
    return `**Nothing inside this session's focus (${outside.dirs}) depends on it.** ${areas} changed; ` +
      `${plural(outside.count, 'dependent symbol')} outside it, listed under Outside focus.`;
  }
  if (symbols === 0) {
    return `**Nothing outside this diff depends on it.** ${areas} changed; no indexed dependents at ${depthLabel(r.depth)}.`;
  }
  return `**${areas} changed → ${plural(r.modules.length, 'area')} can be affected.** ${plural(symbols, 'dependent symbol')}, ${depthLabel(r.depth)}.`;
}

/** One sentence on whether the diff brought its tests, leading with areas no test reaches. */
function testHeadline(r: BlastReport): string | null {
  if (r.areas.length === 0) return null;
  const none = r.areas.filter((a) => a.tests === 'none');
  const stale = r.areas.filter((a) => a.tests === 'stale');
  const changed = r.areas.filter((a) => a.tests === 'changed');
  const parts: string[] = [];
  if (none.length > 0) parts.push(`**no test reaches ${none.map((a) => a.label).join(', ')}**`);
  if (stale.length > 0) {
    parts.push(`${stale.map((a) => a.label).join(', ')} ${stale.length === 1 ? 'has tests' : 'have tests'} the diff did not touch`);
  }
  if (changed.length > 0) {
    parts.push(`${plural(changed.length, 'area')} updated ${changed.length === 1 ? 'its' : 'their'} tests`);
  }
  if (parts.length === 0) return null;
  return `Tests: ${parts.join('; ')}.`;
}

/** One row per affected area with the nearest symbol to start reading at. */
function impactTable(r: BlastReport): string[] {
  const shown = r.modules.slice(0, MAX_TABLE_ROWS);
  const hidden = r.modules.slice(MAX_TABLE_ROWS);
  const areaOf = new Map<string, string>();
  for (const a of r.areas) for (const f of a.files) areaOf.set(f, a.label);
  const rows = ['| Can be affected | Symbols | Nearest hop | Reached from |', '| --- | --: | --- | --- |'];
  for (const mod of shown) {
    const nearest = mod.symbols[0];
    const hop = nearest
      ? `\`${nearest.path}:${nearest.span}\` ${nearest.name} — ${nearest.relation}, depth ${nearest.depth}${nearest.questionable ? ', questionable' : ''}`
      : '—';
    // Two names, then a count, so the column cannot outgrow the table.
    const names = [...new Set(mod.from.map((f) => areaOf.get(f) ?? f))];
    const from = names.length === 0 ? '—'
      : names.length <= 2 ? names.join(', ')
        : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
    rows.push(`| ${mod.label} | ${mod.symbols.length} | ${hop} | ${from} |`);
  }
  if (hidden.length > 0) {
    const symbols = hidden.reduce((n, m) => n + m.symbols.length, 0);
    rows.push(`| _${plural(hidden.length, 'smaller area')}_ | ${symbols} | ${hidden.slice(0, 3).map((m) => m.label).join(', ')}${hidden.length > 3 ? ', …' : ''} | see below |`);
  }
  return rows;
}

/**
 * The collapsed sections: every dependent symbol, the per-area test signal, and
 * the test suites. The blank line after each `</summary>` is required for GitHub
 * to render markdown inside a details block.
 */
function detailSections(r: BlastReport, symbols: number): string[] {
  const out: string[] = [];
  if (symbols > 0) {
    out.push('<details>');
    out.push(`<summary><strong>All ${plural(symbols, 'dependent symbol')}</strong>, grouped by area</summary>`);
    out.push('');
    out.push(...symbolList(r.modules, symbols));
    out.push('</details>');
  }
  if (r.areas.length > 0) {
    const by = (s: string): number => r.areas.filter((a) => a.tests === s).length;
    const states = [
      by('changed') > 0 ? `${by('changed')} ✓` : '',
      by('stale') > 0 ? `${by('stale')} ⚠` : '',
      by('none') > 0 ? `${by('none')} ✗` : '',
      by('na') > 0 ? `${by('na')} –` : '',
    ].filter(Boolean).join(' · ');
    out.push('<details>');
    out.push(`<summary><strong>Test signal</strong> per changed area — ${states}</summary>`);
    out.push('');
    out.push('_Reached = a node under a test path has a resolved edge into the changed symbol. It undercounts anything called indirectly — through a CLI, a spawned process or a dynamic import — so read a low ratio as “look here”, never as a coverage gate._');
    out.push('');
    for (const a of r.areas) {
      const bits = a.behavioural > 0 ? [`${a.reached} of ${a.behavioural} reached`] : [];
      if (a.changedTestFiles.length > 0) {
        bits.push(`${plural(a.changedTestFiles.length, 'test file')} changed here: ${a.changedTestFiles.map((f) => `\`${f}\``).join(', ')}`);
      } else if (a.testFiles.length > 0) {
        bits.push(`${plural(a.testFiles.length, 'test file')} ${a.testFiles.length === 1 ? 'reaches' : 'reach'} it, none changed here`);
      } else if (a.behavioural > 0) bits.push('no test file reaches it');
      else bits.push('no function, method, class or component changed here');
      out.push(`- ${TEST_GLYPH[a.tests]} **${a.label}** — ${bits.join(' · ')}`);
      if (a.unreached.length > 0) {
        out.push(`  - not reached: ${a.unreached.slice(0, MAX_UNREACHED_LISTED).map((n) => `\`${n}\``).join(', ')}${a.unreached.length > MAX_UNREACHED_LISTED ? `, …${a.unreached.length - MAX_UNREACHED_LISTED} more` : ''}`);
      }
    }
    out.push('');
    out.push('</details>');
  }
  if (r.testModules.length > 0) {
    const symbolCount = r.testModules.reduce((n, m) => n + m.symbols.length, 0);
    const files = new Set(r.testModules.flatMap((m) => m.files));
    out.push('<details>');
    out.push(`<summary>${plural(files.size, 'test suite')} also ${files.size === 1 ? 'references' : 'reference'} this code</summary>`);
    out.push('');
    // Names only the table: this report draws no diagram.
    out.push(`${plural(symbolCount, 'symbol')}, kept out of the table so they cannot crowd out the areas a reviewer has to look at.`);
    out.push('');
    for (const f of [...files].sort().slice(0, MAX_TEST_FILES_LISTED)) out.push(`- \`${f}\``);
    if (files.size > MAX_TEST_FILES_LISTED) out.push(`- …${files.size - MAX_TEST_FILES_LISTED} more`);
    out.push('');
    out.push('</details>');
  }
  return out;
}

/**
 * Every dependent symbol of `modules` (`total` of them), grouped by module, up to
 * MAX_SYMBOLS_LISTED rows, then a count of the rows left out. Each module's block
 * ends with a blank line. Both the in-focus list and the "Outside focus" section
 * use it, each with its own cap.
 */
function symbolList(modules: readonly Module[], total: number): string[] {
  const out: string[] = [];
  let listed = 0;
  for (const mod of modules) {
    out.push(`**${mod.label}** — ${plural(mod.symbols.length, 'symbol')} in ${plural(mod.files.length, 'file')}`);
    out.push('');
    for (const s of mod.symbols) {
      if (listed >= MAX_SYMBOLS_LISTED) break;
      out.push(`- \`${s.path}:${s.span}\` — ${s.name} (${s.relation}, depth ${s.depth}${s.questionable ? ', questionable' : ''})`);
      listed++;
    }
    out.push('');
    if (listed >= MAX_SYMBOLS_LISTED) {
      // `listed` counts printed rows only, so `total - listed` is the rows not printed.
      // This avoids an off-by-one when the cap falls inside an area's list and
      // avoids printing "…0 further symbols" when exactly 60 rows are listed.
      if (total > listed) {
        out.push(`…${plural(total - listed, 'further symbol')} not listed.`);
        out.push('');
      }
      break;
    }
  }
  return out;
}

/**
 * What the report cannot see or vouch for: deleted and unindexed files, so "no
 * dependents" is not read as "safe", and dependents marked questionable.
 */
function caveatLines(r: BlastReport): string[] {
  const out: string[] = [];
  if (r.deleted.length > 0) {
    out.push(`⚠️ ${plural(r.deleted.length, 'deleted file')} (${r.deleted.slice(0, MAX_CAVEAT_PATHS).join(', ')}) — ` +
      'their dependents cannot be computed from a graph built at this commit, since the files are gone from it.');
  }
  if (r.unindexed.length > 0) {
    out.push(`⚠️ ${plural(r.unindexed.length, 'changed file')} not in the graph (${r.unindexed.slice(0, MAX_CAVEAT_PATHS).join(', ')}) — ` +
      'no parser claims the extension, or the index predates the file.');
  }
  // Counts every marked dependent in `impacted`, including those inside changed
  // files and test files, which the module lists leave out. Never set under strict.
  const marked = r.impacted.filter((s) => s.questionable).length;
  if (marked > 0) {
    out.push(`${plural(marked, 'dependent')} reached only through name-matched calls ${marked === 1 ? 'is' : 'are'} ` +
      `marked questionable; strict (\`--strict\`, or \`strict: true\` over MCP) leaves ${marked === 1 ? 'it' : 'them'} out.`);
  }
  return out;
}

/** The text report's module blocks: a header and up to MAX_TEXT_SYMBOLS dependents each, a blank line after every block. */
function textModules(modules: readonly Module[]): string[] {
  const lines: string[] = [];
  for (const mod of modules) {
    lines.push(`${mod.label} — ${plural(mod.symbols.length, 'symbol')} in ${plural(mod.files.length, 'file')}`);
    for (const s of mod.symbols.slice(0, MAX_TEXT_SYMBOLS)) {
      lines.push(`  ${s.relation} ← ${s.name} (${s.path}:${s.span}) [depth ${s.depth}]${s.questionable ? ' [questionable]' : ''}`);
    }
    const hidden = mod.symbols.length - MAX_TEXT_SYMBOLS;
    if (hidden > 0) lines.push(`  …${plural(hidden, 'more symbol')}`);
    lines.push('');
  }
  return lines;
}

/** Terminal report: same content as the markdown, without the table and the collapsed sections. Its `## Outside focus (N)` line is the one markdown token it keeps. */
export function textReport(r: BlastReport): string {
  const symbols = r.modules.reduce((n, m) => n + m.symbols.length, 0);
  const lines = [
    `blast radius — ${r.basis} (${depthLabel(r.depth)})`,
    `  changed: ${plural(r.changed.length, 'file')} in ${plural(r.areas.length, 'area')}, ${plural(r.seeds.length, 'seed symbol')}`,
    `  impacted: ${plural(symbols, 'symbol')} in ${plural(r.modules.length, 'area')}`,
    '',
  ];
  for (const a of r.areas) {
    lines.push(`${TEST_GLYPH[a.tests]} ${a.label} — ${plural(a.files.length, 'changed file')}, ${a.reached}/${a.behavioural} reached by a test`);
  }
  if (r.areas.length > 0) lines.push('');
  lines.push(...textModules(r.modules));
  const outside = r.outsideFocus;
  if (symbols === 0) {
    lines.push(outside && outside.count > 0
      ? `no indexed dependents inside this session's focus (${outside.dirs})`
      : 'no indexed dependents outside the changed files themselves', '');
  }
  if (outside && outside.count > 0) {
    lines.push(outsideFocusHeading(outside.count), '', ...textModules(outside.modules));
  }
  if (r.testModules.length > 0) {
    const files = new Set(r.testModules.flatMap((m) => m.files));
    lines.push(`${plural(files.size, 'test suite')} also ${files.size === 1 ? 'references' : 'reference'} this code (not listed)`, '');
  }
  // Print caveats with the text-presentation sign (no emoji selector) in a terminal.
  for (const line of caveatLines(r)) lines.push(line.replace(/⚠️ /, '⚠ '), '');
  return lines.join('\n').replace(/\n+$/, '\n');
}
