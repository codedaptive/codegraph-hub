import * as path from 'path';
import { gitHidden as git } from './git-hidden';
import { indexDir } from './index-dir';
import { makeAppRepo as makeRepo } from './make-app-repo';

/** A repository `main` with an index, and a fresh worktree `wt` of it with none. */
export async function repoWithWorktree(workspace: string): Promise<{ main: string; wt: string }> {
  const main = path.join(workspace, 'main');
  makeRepo(main);
  await indexDir(main);
  const wt = path.join(workspace, 'feature');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  return { main, wt };
}
