/**
 * Splits a `BlastReport` by the session focus (`serve --mcp --focus <dir>`): the
 * dependents inside the focus stay in `modules`, the rest move to
 * `outsideFocus`, so blast still covers the whole repository and an agent sees
 * dependents outside the focus under `## Outside focus (N)`, as the built-in
 * callers and impact tools do.
 *
 * The focus is read only through host's `inFocus`, on prefixes
 * `focusPrefixesOfTool` (../shared/focus.ts) computed from host's
 * `focusPrefixesFor`; this module never compares a path to the raw focus.
 */
import { inFocus } from '../../host/server/session-scope';
import type { BlastReport, Impacted, Module } from './blast';

/**
 * `mod` narrowed to `symbols`, in their order, with `files` recomputed from them
 * (sorted, as `blast.ts` sorts a module's own `files`, so a module that keeps all
 * its symbols keeps its `files` too). `key` (the directory) and `from` (the changed files whose
 * walk reached the original module) stay as they were. `label` also stays, but it is the shallowest
 * original symbol's name (`hubLabel`), so a side can head with a name from the other side.
 */
function moduleOf(mod: Module, symbols: Impacted[]): Module {
  return { ...mod, files: [...new Set(symbols.map((s) => s.path))].sort(), symbols };
}

/**
 * The report for a session that has a focus, whose membership rule is `prefixes`
 * (host's `focusPrefixesFor` answer; call this only for a session with a focus, an
 * unfocused one keeps its report as it is). `null` means the focus holds the whole
 * index: nothing is split, `modules` stays as it is and `outsideFocus` is empty. Otherwise `modules` keep
 * the symbols whose path is in focus, `outsideFocus` gets the others, each
 * grouped by the module they were in; a module left with no symbols is dropped
 * from that side. `dirs` is the focus as a sentence names it. `impacted`,
 * `testModules`, `areas`, `seeds` and `changed` are untouched, so dependents in
 * test-only directories stay in `testModules` and are not in `count`.
 *
 * `outsideFocus` is always set, even with nothing outside, so a focused session's
 * json answer always carries it; the renderers print its section only when
 * `count > 0`.
 */
export function splitReportByFocus(report: BlastReport, prefixes: readonly string[] | null, dirs: string): BlastReport {
  if (prefixes === null) return { ...report, outsideFocus: { dirs, count: 0, modules: [] } };
  const inside: Module[] = [];
  const outside: Module[] = [];
  let count = 0;
  for (const mod of report.modules) {
    const keep = mod.symbols.filter((s) => inFocus(s.path, prefixes));
    const rest = mod.symbols.filter((s) => !inFocus(s.path, prefixes));
    if (keep.length > 0) inside.push(moduleOf(mod, keep));
    if (rest.length > 0) outside.push(moduleOf(mod, rest));
    count += rest.length;
  }
  return { ...report, modules: inside, outsideFocus: { dirs, count, modules: outside } };
}
