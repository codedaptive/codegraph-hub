/**
 * The extension registry: loads every CodegraphExtension once per process and
 * answers which extension tools exist. The contract is `./README.md`; the types
 * are `./api`.
 *
 * Loading is once per process. Every CLI invocation that reaches
 * `program.parse()` (`serve --mcp` included; not the bare installer run or
 * -v) loads at startup, in `registerExtensionCommands` just before
 * `program.parse()`. A process that builds an MCP server without the CLI loads
 * on its first tools/list or tools/call. A query-pool worker reaches the
 * registry only from `dispatchTool`'s default branch, so it loads on its first
 * dispatch of a non-built-in tool name: a worker inherits `process.env` at
 * spawn, so it reads the same CODEGRAPH_EXTENSION_MODULES and finds the same
 * compiled siblings.
 *
 * Import-cycle rule: `src/mcp/tools.ts` imports this module as a value, so this
 * module takes nothing from tools.ts but types. Two things it needs from there
 * are handed in by tools.ts through `setBuiltins` when tools.ts loads: the
 * built-in tool names an extension may not shadow, and the read-only
 * annotations every built-in carries, which every served extension tool carries
 * in place of its own. Both are read when the served tool list is built. (A
 * lazy `require('../../mcp/tools')` would not do: vitest cannot serve a require
 * of a .ts module.)
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Command } from 'commander';
import type { ToolAnnotations } from '../../mcp/tools';
import type { CodegraphExtension, ExtensionTool, ExtensionToolContext } from './api';

/**
 * The name rule for an extension tool; the `codegraph_` prefix keeps the
 * short-name allowlist working.
 */
const TOOL_NAME = /^codegraph_[a-z][a-z0-9_]*$/;

/** Comma-separated absolute paths of extra extension modules to load. */
const MODULES_ENV = 'CODEGRAPH_EXTENSION_MODULES';

/** Extensions in load order; null until the first call loads them. */
let extensions: CodegraphExtension[] | null = null;
/**
 * Every accepted tool, in load order, keyed by the name it was validated
 * under. Each value is `addTool`'s frozen snapshot, not the extension's object,
 * and has no `annotations` (`extensionTools` adds the built-ins').
 * Duplicates were refused at registration.
 */
let registered = new Map<string, ExtensionTool>();
/**
 * `registered` minus any name a built-in owns, each definition carrying the
 * built-ins' annotations; null until built with both known.
 */
let served: ExtensionTool[] | null = null;
/** Supplied by tools.ts at its load (see the header). */
let builtinToolNames: (() => readonly string[]) | null = null;
/** The built-ins' annotations; supplied by tools.ts with the names. */
let builtinAnnotations: ToolAnnotations | null = null;

function warn(message: string): void {
  process.stderr.write(`[CodeGraph] ${message}\n`);
}

/**
 * Tells the registry which tool names are built in and which annotations the
 * built-ins carry. Called once by tools.ts at module load; `names` is a getter
 * so the names are read only when a list is built. The annotations are copied
 * onto each served definition, so the caller's object is never frozen.
 */
export function setBuiltins(names: () => readonly string[], annotations: ToolAnnotations): void {
  builtinToolNames = names;
  builtinAnnotations = annotations;
  served = null;
}

/**
 * The compiled extension modules beside this directory: `<dir>/extension.js`,
 * never `.ts`. Sorted by directory name in lexicographic UTF-16 code-unit
 * order (JS string `<`, not code-point order and not locale order), so the load
 * order, and with it the winner of a duplicate tool name, is the same on every
 * machine and in every locale.
 */
function discoveredModules(): string[] {
  const root = path.join(__dirname, '..');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  // UTF-16 code-unit order via `<`/`>`, not localeCompare: the locale must not
  // change the order. (A name with an astral character sorts by its surrogate
  // pair, so it lands before a BMP character in U+E000..U+FFFF; still deterministic.)
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory()) continue;
    // `.js` only: under vitest the siblings are `.ts` sources, and Node's type
    // stripping would otherwise load them a second time outside vitest's graph.
    const file = path.join(root, entry.name, 'extension.js');
    if (fs.existsSync(file)) found.push(file);
  }
  return found;
}

/** The modules CODEGRAPH_EXTENSION_MODULES lists; a relative entry is skipped with a warning. */
function envModules(): string[] {
  const raw = process.env[MODULES_ENV];
  if (!raw || !raw.trim()) return [];
  const found: string[] = [];
  for (const entry of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    if (!path.isAbsolute(entry)) {
      warn(`extension ${entry} skipped: ${MODULES_ENV} entries must be absolute paths`);
      continue;
    }
    found.push(entry);
  }
  return found;
}

/**
 * The error text for a warning line. Never throws, whatever was thrown: a
 * module can throw a value `String()` cannot convert (a null-prototype object),
 * an Error whose `message` getter throws, or a Proxy whose traps throw, and the
 * warning must still be written so loading continues.
 */
function reason(err: unknown): string {
  try {
    if (err instanceof Error) {
      const message: unknown = err.message;
      if (typeof message === 'string') return message;
    }
    return String(err);
  } catch {
    return 'it threw a value that cannot be printed';
  }
}

/** Loads one module's extension; never throws (a bad module is one stderr line). */
function loadModule(file: string): void {
  let ext: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as { default?: unknown; extension?: unknown };
    ext = mod.default ?? mod.extension;
  } catch (err) {
    warn(`extension ${file} skipped: ${reason(err)}`);
    return;
  }
  addExtension(ext, file);
}

/**
 * Records an extension, keeping only its tools that pass `addTool`'s rules.
 * The shared path for loaded modules and `registerExtension`. Never throws: a
 * value with no string `name` is skipped (the name is read once, so a getter
 * cannot pass the check and then change), a `tools` that is present but not
 * an array loses all its tools (the extension and its `registerCommands`
 * stay), and a tool whose properties throw when read is dropped and the tools
 * after it are still tried. Each is one stderr line. `source` names the module
 * in the warning.
 */
function addExtension(value: unknown, source: string): void {
  let ext: CodegraphExtension;
  let name: string;
  let tools: unknown;
  try {
    const rawName: unknown = value && typeof value === 'object' ? (value as CodegraphExtension).name : undefined;
    if (typeof rawName !== 'string') {
      warn(`extension ${source} skipped: it exports no extension (expected \`default\` or \`extension\` with a string \`name\`)`);
      return;
    }
    ext = value as CodegraphExtension;
    name = rawName;
    tools = ext.tools;
  } catch (err) {
    warn(`extension ${source} skipped: ${reason(err)}`);
    return;
  }
  (extensions ??= []).push(ext);
  served = null;
  if (tools === undefined || tools === null) return;
  try {
    if (!Array.isArray(tools)) {
      warn(`extension ${name}: tools dropped: \`tools\` is not an array`);
      return;
    }
    for (const tool of tools as unknown[]) {
      try {
        addTool(name, tool);
      } catch (err) {
        warn(`extension ${name}: a tool dropped: ${reason(err)}`);
      }
    }
  } catch (err) {
    // An array whose iteration throws (a Proxy, a throwing element getter):
    // the tools accepted before the throw stay.
    warn(`extension ${name}: remaining tools dropped: ${reason(err)}`);
  }
}

/** A non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Freezes JSON-parsed data all the way down (it has no cycles). */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Accepts one tool or warns why not. What is registered is a snapshot, never
 * the extension's own objects: `definition` is copied once through JSON (the
 * form tools/list sends, so `_meta` and the whole schema survive), stripped of
 * its `annotations` (the served copy carries the built-ins' instead, see
 * `extensionTools`), and deep-frozen; `handle` is read once and called with
 * the extension's tool as `this`. The rules run on the snapshot, so the name
 * checked against the pattern and the duplicate set is the name listed and
 * looked up for the rest of the process: a getter that answers differently on
 * a later read, or a change to the extension's definition after registration,
 * changes nothing.
 *
 * The rules: the name matches TOOL_NAME, `description` is a string,
 * `inputSchema` is an object with `type: 'object'` and a `properties` object
 * (tools/list reads `inputSchema.properties`), `handle` is a function, and no
 * earlier tool has the name. A property that throws while the snapshot is
 * taken, or a definition JSON cannot copy (a cycle, a BigInt), throws to the
 * caller, which drops this tool and goes on to the next.
 */
function addTool(extName: string, tool: unknown): void {
  const source = tool as Partial<ExtensionTool> | null | undefined;
  const rawDefinition: unknown = source?.definition;
  const json = rawDefinition === undefined ? undefined : JSON.stringify(rawDefinition);
  const definition: unknown = json === undefined ? undefined : JSON.parse(json);
  const name: unknown = isRecord(definition) ? definition.name : undefined;
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
    // The snapshot is JSON data, so JSON.stringify can always print it.
    const shown = typeof name === 'string' ? name : String(JSON.stringify(name));
    warn(`extension ${extName}: tool ${shown} dropped: the name must match ${TOOL_NAME}`);
    return;
  }
  const def = definition as Record<string, unknown>;
  if (typeof def.description !== 'string') {
    warn(`extension ${extName}: tool ${name} dropped: \`description\` must be a string`);
    return;
  }
  const schema = def.inputSchema;
  if (!isRecord(schema) || schema.type !== 'object' || !isRecord(schema.properties)) {
    warn(`extension ${extName}: tool ${name} dropped: \`inputSchema\` must be { type: 'object', properties: {...} }`);
    return;
  }
  const handle: unknown = source?.handle;
  if (typeof handle !== 'function') {
    warn(`extension ${extName}: tool ${name} dropped: it has no handle function`);
    return;
  }
  if (registered.has(name)) {
    warn(`extension ${extName}: tool ${name} dropped: an earlier extension already registered it`);
    return;
  }
  const run = handle as ExtensionTool['handle'];
  // An extension does not set its own annotations: every extension tool is
  // served with the built-ins' read-only ones (see extensionTools).
  delete def.annotations;
  registered.set(name, Object.freeze({
    definition: deepFreeze(definition as ExtensionTool['definition']),
    handle: (args: Record<string, unknown>, ctx: ExtensionToolContext) => run.call(tool, args, ctx),
  }));
}

/**
 * Every loaded extension: the compiled siblings first, then
 * CODEGRAPH_EXTENSION_MODULES, then any `registerExtension` calls. Loads once
 * per process; never throws.
 */
export function loadExtensions(): readonly CodegraphExtension[] {
  if (extensions) return extensions;
  extensions = [];
  const seen = new Set<string>();
  for (const file of [...discoveredModules(), ...envModules()]) {
    const key = path.resolve(file);
    if (seen.has(key)) continue;
    seen.add(key);
    loadModule(key);
  }
  return extensions;
}

/**
 * Registers an extension in-process, after the discovered and env-listed ones.
 * Validated as a loaded module is, and never throws: no string `name` skips
 * it, a non-array `tools` drops all its tools, and each invalid tool is dropped;
 * every rejection is one stderr warning and the rest of the extension stays.
 */
export function registerExtension(ext: CodegraphExtension): void {
  loadExtensions();
  addExtension(ext, 'registerExtension()');
}

/**
 * The extension tools that may be served: the snapshot of every accepted tool
 * whose validated name no built-in owns (a built-in name would be shadowed by
 * the switch in `dispatchTool`, and explore's session bookkeeping keys on its
 * name), its definition carrying a copy of the built-ins' annotations. This is
 * the one list tools/list and `findExtensionTool` (and so a worker's dispatch)
 * read. The definitions are frozen, so a served definition's name is always
 * the name checked here.
 */
export function extensionTools(): ExtensionTool[] {
  loadExtensions();
  if (served) return served;
  const builtins = new Set(builtinToolNames ? builtinToolNames() : []);
  const list: ExtensionTool[] = [];
  for (const [name, tool] of registered) {
    if (builtins.has(name)) {
      warn(`extension tool ${name} dropped: a built-in tool has that name`);
      continue;
    }
    list.push(builtinAnnotations
      ? Object.freeze({
        definition: deepFreeze({ ...tool.definition, annotations: { ...builtinAnnotations } }),
        handle: tool.handle,
      })
      : tool);
  }
  // Cache only once tools.ts has handed in the built-ins, so an early lookup
  // can neither let a colliding tool through nor fix a list without the
  // annotations for the rest of the process.
  if (builtinToolNames && builtinAnnotations) served = list;
  return list;
}

/** The served tool with this validated name; never a built-in's name. */
export function findExtensionTool(name: string): ExtensionTool | undefined {
  return extensionTools().find(t => t.definition.name === name);
}

export function isExtensionTool(name: string): boolean {
  return findExtensionTool(name) !== undefined;
}

/**
 * Lets every extension add its CLI commands. Synchronous, because the CLI's
 * `main()` is. An extension whose `registerCommands` throws is skipped with a
 * warning.
 */
export function registerExtensionCommands(program: Command): void {
  for (const ext of loadExtensions()) {
    try {
      if (typeof ext.registerCommands !== 'function') continue;
      ext.registerCommands(program);
    } catch (err) {
      let name = '(unnamed)';
      try { name = String(ext.name); } catch { /* a throwing name getter: keep the placeholder */ }
      warn(`extension ${name} commands skipped: ${reason(err)}`);
    }
  }
}

/**
 * Forgets every loaded and registered extension, so the next call re-reads
 * CODEGRAPH_EXTENSION_MODULES and discovery. Tests only. Node's require cache
 * is left alone: a module re-listed later resolves to the same exports object.
 */
export function __resetExtensionsForTests(): void {
  extensions = null;
  registered = new Map();
  served = null;
}
