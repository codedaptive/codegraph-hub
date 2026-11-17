/**
 * The answer to a call on a path in no git worktree (R-46): codegraph indexes and answers only for git
 * worktree roots, so such a call gets guidance and nothing is opened, built or registered for it. The
 * answer is success-shaped, never `isError`: an error teaches the agent to abandon codegraph for the
 * session, guidance lets it correct the path or use its built-in tools.
 */
import type { ToolResult } from '../../../mcp/tools';
import { gitRootByStat } from './index-root';

/** Null when `projectPath` is inside a git worktree; otherwise the not-a-repository guidance. */
export function notARepositoryAnswer(
  projectPath: string,
  gitRoot: (p: string) => string | null = gitRootByStat,
): ToolResult | null {
  if (gitRoot(projectPath) !== null) return null;
  return {
    content: [
      {
        type: 'text',
        text:
          `${projectPath} is not in a git repository. codegraph indexes and answers only for git worktrees. ` +
          'Pass a projectPath inside one, and use your built-in tools (Read/Grep/Glob) for this code.',
      },
    ],
  };
}
