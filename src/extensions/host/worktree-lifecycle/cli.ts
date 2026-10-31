/**
 * The actions of `codegraph project list|pin|unpin|remove`, the project
 * registry's CLI (./project-registry.ts). A PINNED project is never
 * idle-released from an MCP server's project cache; a SEEDED one
 * got its index from CodeGraph itself (copied from a sibling git worktree, or
 * cold-built by the MCP server), and the housekeeping sweep deletes that index
 * once the worktree is removed. `remove` only unregisters: it deletes no file.
 *
 * Loaded only with `await import`, by the commands ../extension.ts registers.
 */
import * as fs from 'fs';
import * as path from 'path';
import { isInitialized } from '../../../directory';
import { getGlyphs } from '../../../ui/glyphs';
import { ansiColorsEnabled } from '../../../ui/color';
import { gitCommonDirAsync } from './git';
import {
  PROJECT_FLAG_PINNED,
  PROJECT_FLAG_SEEDED,
  getRegisteredProject,
  listRegisteredProjects,
  pinProject,
  registerProject,
  unpinProject,
  unregisterProject,
} from './project-registry';

/** `text` in ANSI colour `code` when the CLI prints colour (src/ui/color.ts decides). */
function paint(code: string, text: string): string {
  return ansiColorsEnabled() ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function success(message: string): void {
  console.log(paint('32', getGlyphs().ok) + ' ' + message);
}

function error(message: string): void {
  console.error(paint('31', getGlyphs().err) + ' ' + message);
}

function info(message: string): void {
  console.log(paint('34', getGlyphs().info) + ' ' + message);
}

/**
 * The index root `pathArg` belongs to: the path itself when it holds
 * `.codegraph/codegraph.db`, else the nearest directory above it that does,
 * else the path as given. The same rule as src/bin/codegraph.ts's private
 * resolveProjectPath, duplicated because that one is not exported; it is the
 * root a tool call would resolve to, as the MCP project cache keys it.
 */
function resolveProjectPath(pathArg: string): string {
  const absolutePath = path.resolve(pathArg);
  if (isInitialized(absolutePath)) return absolutePath;
  let current = absolutePath;
  const root = path.parse(current).root;
  while (current !== root) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    if (isInitialized(current)) return current;
  }
  return absolutePath;
}

/** Names of the flag bits set in a registry record, for the text listing. */
function projectFlagNames(flags: number): string[] {
  const names: string[] = [];
  if (flags & PROJECT_FLAG_PINNED) names.push('pinned');
  if (flags & PROJECT_FLAG_SEEDED) names.push('seeded');
  return names;
}

/** `codegraph project list [-j]`. */
export function runProjectList(options: { json?: boolean }): void {
  const projects = listRegisteredProjects();
  if (options.json) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }
  if (projects.length === 0) {
    info('No registered projects.');
    return;
  }
  for (const p of projects) {
    const flags = projectFlagNames(p.flags);
    console.log(`${p.root}  ${flags.length ? flags.join(',') : '-'}  registered ${p.registeredAt}${p.commonDir ? `  repo ${p.commonDir}` : ''}`);
  }
}

/** `codegraph project pin <path>`: exits 1 when the directory does not exist. */
export async function runProjectPin(pathArg: string): Promise<void> {
  const absolute = path.resolve(pathArg);
  if (!fs.existsSync(absolute)) {
    error(`No such directory: ${absolute}`);
    process.exit(1);
  }
  // Pin the index root a tool call would resolve to, as the MCP cache keys it.
  const root = resolveProjectPath(absolute);
  // Recorded on pin so the housekeeping sweep can tell when a pinned
  // worktree is removed; null when the root is not in a git repository.
  const commonDir = getRegisteredProject(root)?.commonDir ?? await gitCommonDirAsync(root);
  registerProject(root, { commonDir });
  const rec = pinProject(root);
  success(`Pinned ${rec.root}`);
}

/** `codegraph project unpin <path>`. */
export function runProjectUnpin(pathArg: string): void {
  // The index root first (what pin recorded), then the path as given (a
  // removed directory no longer resolves to its index root).
  const rec = unpinProject(resolveProjectPath(pathArg)) ?? unpinProject(path.resolve(pathArg));
  if (!rec) {
    info(`${path.resolve(pathArg)} is not registered ${getGlyphs().dash} nothing to do`);
    return;
  }
  success(`Unpinned ${rec.root}`);
}

/** `codegraph project remove <path>`: unregisters, deletes nothing. */
export function runProjectRemove(pathArg: string): void {
  // Same lookup order as unpin.
  const removed = unregisterProject(resolveProjectPath(pathArg)) || unregisterProject(path.resolve(pathArg));
  if (!removed) {
    info(`${path.resolve(pathArg)} is not registered ${getGlyphs().dash} nothing to do`);
    return;
  }
  success(`Unregistered ${path.resolve(pathArg)}`);
}
