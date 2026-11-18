import { describe, expect, it } from 'vitest';
import * as path from 'path';

const MODULE = path.resolve(__dirname, '../../../src/extensions/host/worktree-lifecycle/dropStrayFrontloadRoots');

type DropRoots = <P extends { exploreRoot: string | null | undefined; nudgeProjects: string[] }>(
  plan: P, inRepository: (root: string) => boolean,
) => P;

async function loadDropRoots(): Promise<DropRoots> {
  const mod = (await import(/* @vite-ignore */ MODULE)) as { dropStrayFrontloadRoots: DropRoots };
  return mod.dropStrayFrontloadRoots;
}

const accepted = (root: string) => root.startsWith('/git/');

describe('dropStrayFrontloadRoots', () => {
  it('drops a stray explore root', async () => {
    const drop = await loadDropRoots();
    expect(drop({ exploreRoot: '/stray', nudgeProjects: [] }, accepted).exploreRoot).toBeNull();
  });

  it('keeps an accepted explore root', async () => {
    const drop = await loadDropRoots();
    expect(drop({ exploreRoot: '/git/one', nudgeProjects: [] }, accepted).exploreRoot).toBe('/git/one');
  });

  it('filters stray nudge projects while preserving accepted order', async () => {
    const drop = await loadDropRoots();
    const plan = { exploreRoot: null, nudgeProjects: ['/git/second', '/stray', '/git/first', '/other'] };
    expect(drop(plan, accepted).nudgeProjects).toEqual(['/git/second', '/git/first']);
  });

  it('carries other plan fields through unchanged', async () => {
    const drop = await loadDropRoots();
    const plan = { exploreRoot: '/stray', nudgeProjects: [], viaSubScan: true, marker: 'retained' };
    expect(drop(plan, accepted)).toEqual({ exploreRoot: null, nudgeProjects: [], viaSubScan: true, marker: 'retained' });
  });

  it('returns a copy without mutating the input or its nudge list', async () => {
    const drop = await loadDropRoots();
    const plan = { exploreRoot: '/stray', nudgeProjects: ['/stray', '/git/one'], viaSubScan: true };
    const result = drop(plan, accepted);
    expect(result).not.toBe(plan);
    expect(result.nudgeProjects).not.toBe(plan.nudgeProjects);
    expect(plan).toEqual({ exploreRoot: '/stray', nudgeProjects: ['/stray', '/git/one'], viaSubScan: true });
  });

  it.each([null, undefined])('keeps an absent explore root %s without checking it', async (root) => {
    const drop = await loadDropRoots();
    const result = drop({ exploreRoot: root, nudgeProjects: [] }, () => { throw new Error('unexpected root'); });
    expect(result.exploreRoot).toBe(root);
  });
});
