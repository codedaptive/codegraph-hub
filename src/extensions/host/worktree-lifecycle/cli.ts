/**
 * The actions of `codegraph project list|seed|pin|unpin|remove`, the project
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
import { gitCommonDirAsync, gitWorktreeRootAsync } from './git';
import { gitRootByStat } from '../server/index-root';
import type { BuilderRoute } from '../builder/cli-route';
import type { WorktreeSeedOutcome } from './seed';
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

type SeedProjectDeps = { route?: () => Promise<BuilderRoute | null> };

/** Seed through the running server's builder, or in process when no builder takes the request. */
export async function seedProjectNow(absolute: string, deps?: SeedProjectDeps): Promise<WorktreeSeedOutcome> {
  try {
    const route = await (deps?.route
      ? deps.route()
      : (await import('../builder/cli-route')).builderRoute());
    if (route) {
      try {
        const answer = await route.seed(absolute);
        if (answer.routed) return answer.result;
      } finally {
        route.close();
      }
    }
    const { seedWorktreeNow } = await import('./seed');
    return await seedWorktreeNow(absolute, { log: () => {} });
  } catch (err) {
    return { kind: 'failed', root: absolute, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** One result line, shared by explicit seeds and the seed attempted before a pin. */
function printSeedOutcome(outcome: WorktreeSeedOutcome): 0 | 1 | 3 {
  switch (outcome.kind) {
    case 'indexed':
      success(`${outcome.root} already has an index`);
      return 0;
    case 'seeded':
      success(`Seeded ${outcome.root} from ${outcome.source} (${outcome.method})`);
      return 0;
    case 'no-source':
      info(`Could not seed ${outcome.root}: no sibling worktree has an index`);
      return 3;
    case 'not-git':
      info(`${outcome.root} is not in a git worktree, so no sibling can seed it`);
      return 3;
    case 'queued':
      error(`Could not seed ${outcome.root}: a seed or build of it is already queued in the server`);
      return 1;
    case 'disabled':
      error(`Could not seed ${outcome.root}: automatic seeding is off (CODEGRAPH_NO_AUTO_SEED=1)`);
      return 1;
    case 'failed':
      error(`Could not seed ${outcome.root}: ${outcome.reason}`);
      return 1;
  }
}

/** `codegraph project seed <path>`: 0 indexed, 3 no sibling index, 1 failed. */
export async function projectSeedExitCode(pathArg: string, deps?: SeedProjectDeps): Promise<0 | 1 | 3> {
  const absolute = path.resolve(pathArg);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    error(`No such directory: ${absolute}`);
    return 1;
  }
  return printSeedOutcome(await seedProjectNow(absolute, deps));
}

export async function runProjectSeed(pathArg: string): Promise<void> {
  process.exit(await projectSeedExitCode(pathArg));
}

/**
 * `codegraph project pin <path>`: exit 1 for a missing directory or a path in no git worktree
 * (gitRootByStat is null), which is refused before anything is registered or pinned.
 *
 * The path then resolves as a tool call would resolve it (resolveProjectPath). An index root in no git
 * worktree (the index of a non-git folder above the worktree) is not this project's, so the path's
 * worktree root stands in for it. When that root has an index (the path's own, a sub-index or an indexed
 * ancestor in git), it is pinned, with no seed. Otherwise, unless CODEGRAPH_NO_AUTO_SEED is 1, the
 * worktree root is seeded, with the outcome printed: on `seeded`, `indexed` or `queued` the worktree root
 * is pinned; on any other outcome the resolved root is, as it is with the kill switch on.
 */
export async function runProjectPin(pathArg: string, deps?: SeedProjectDeps): Promise<void> {
  const absolute = path.resolve(pathArg);
  if (!fs.existsSync(absolute)) {
    error(`No such directory: ${absolute}`);
    process.exit(1);
  }
  const gitRoot = gitRootByStat(absolute);
  if (!gitRoot) {
    error(`${absolute} is not in a git repository ${getGlyphs().dash} only git worktrees can be pinned`);
    process.exit(1);
  }
  const indexRoot = resolveProjectPath(absolute);
  const resolved = gitRootByStat(indexRoot) ? indexRoot : gitRoot;
  let root = resolved;
  if (!isInitialized(resolved) && process.env.CODEGRAPH_NO_AUTO_SEED !== '1') {
    const worktree = await gitWorktreeRootAsync(absolute);
    if (worktree) {
      const outcome = await seedProjectNow(worktree, deps);
      printSeedOutcome(outcome);
      if (outcome.kind === 'seeded' || outcome.kind === 'indexed' || outcome.kind === 'queued') root = worktree;
    }
  }
  // Recorded on pin so the housekeeping sweep can tell when a pinned
  // worktree is removed; null when git cannot name the repository.
  const commonDir = getRegisteredProject(root)?.commonDir ?? await gitCommonDirAsync(root);
  registerProject(root, { commonDir });
  const rec = pinProject(root);
  success(`Pinned ${rec.root}`);
}

/**
 * The roots unpin and remove try, in order, without duplicates: the index
 * root a tool call would use (what pin records when the path has an index),
 * the git worktree root (what pin records after seeding a worktree; only for a
 * path that exists), then the path as given. A removed directory has no
 * worktree root and may no longer resolve to its index root, so it is found
 * by the last.
 */
function registeredRootCandidates(pathArg: string): string[] {
  const absolute = path.resolve(pathArg);
  const candidates = [resolveProjectPath(absolute)];
  // For a removed directory gitRootByStat would name the repository around
  // it, not the project the user named.
  const worktree = fs.existsSync(absolute) ? gitRootByStat(absolute) : null;
  if (worktree) candidates.push(worktree);
  candidates.push(absolute);
  return [...new Set(candidates)];
}

/** `codegraph project unpin <path>`. */
export function runProjectUnpin(pathArg: string): void {
  let rec = null;
  for (const root of registeredRootCandidates(pathArg)) {
    rec = unpinProject(root);
    if (rec) break;
  }
  if (!rec) {
    info(`${path.resolve(pathArg)} is not registered ${getGlyphs().dash} nothing to do`);
    return;
  }
  success(`Unpinned ${rec.root}`);
}

/** `codegraph project remove <path>`: unregisters, deletes nothing. */
export function runProjectRemove(pathArg: string): void {
  // Same lookup order as unpin.
  const removed = registeredRootCandidates(pathArg).some((root) => unregisterProject(root));
  if (!removed) {
    info(`${path.resolve(pathArg)} is not registered ${getGlyphs().dash} nothing to do`);
    return;
  }
  success(`Unregistered ${path.resolve(pathArg)}`);
}
