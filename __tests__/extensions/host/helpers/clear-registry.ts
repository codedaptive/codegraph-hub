import { listRegisteredProjects, unregisterProject } from '../../../../src/extensions/host/worktree-lifecycle/project-registry';

/** Unregisters every project in the registry. */
export function clearRegistry(): void {
  for (const p of listRegisteredProjects()) unregisterProject(p.root);
}
