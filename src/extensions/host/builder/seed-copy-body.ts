/**
 * The body of a `seed` job (../worktree-lifecycle/seed.ts builds its spec, ./seed-host.ts runs it), run in the
 * job's child process: copy the index of `source` into `root` (seedFromSibling), register `root` SEEDED with the
 * copy's nonce and its git common dir, report the "Seeded" line as a `{log: line}` progress payload, and answer
 * the copy's method. The staging copy's name carries this process's pid, so a child killed at a limit or after
 * the stop's grace has it removed (./clean-up-ended-job.ts). Seed.ts calls it in its own process when no builder
 * takes the seed.
 */
import { registerProject } from '../worktree-lifecycle/project-registry';
import { seedFromSibling, type SeedMethod } from '../worktree-lifecycle/seed';

export async function seedCopyBody(
  args: { root: string; source: string; commonDir: string | null },
  ctx: { progress(payload: { log: string }): void },
): Promise<SeedMethod> {
  const { method, nonce } = await seedFromSibling(args.root, args.source);
  registerProject(args.root, { seeded: true, commonDir: args.commonDir, seedNonce: nonce });
  ctx.progress({ log: `[CodeGraph MCP] Seeded the index of ${args.root} from ${args.source} (${method}).` });
  return method;
}
