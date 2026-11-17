import { describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { followSymlinkedDir } from '../../../src/extensions/host/scan/follow-symlinked-dir';

const realpath = (p: string): string => p === '/var/p' ? '/private/var/p' : p;

describe('followSymlinkedDir', () => {
  it('follows a target inside the root', () => {
    expect(followSymlinkedDir('/a/root', '/a/root/lib', 'lib', ignore(), realpath)).toBe(true);
  });

  it('follows a target equal to the root', () => {
    expect(followSymlinkedDir('/a/root', '/a/root', 'link', ignore(), realpath)).toBe(true);
  });

  it('does not treat a prefix sibling as inside the root', () => {
    expect(followSymlinkedDir('/a/root', '/a/root2/x', 'link', ignore(), realpath)).toBe(false);
  });

  it('does not follow an unmentioned outside target', () => {
    expect(followSymlinkedDir('/a/root', '/outside/runs', 'data/runs', ignore(), realpath)).toBe(false);
  });

  it('follows an outside target re-included by a link path rule', () => {
    expect(followSymlinkedDir('/a/root', '/outside/runs', 'data/runs', ignore().add('!data/runs'), realpath)).toBe(true);
  });

  it('follows an outside target re-included by a directory rule', () => {
    expect(followSymlinkedDir('/a/root', '/outside/runs', 'data/runs', ignore().add('!data/runs/'), realpath)).toBe(true);
  });

  it('does not follow an ignored outside link with an unrelated negation', () => {
    expect(followSymlinkedDir('/a/root', '/outside/runs', 'data/runs', ignore().add(['data/', '!other']), realpath)).toBe(false);
  });

  it('compares the target with the resolved root', () => {
    expect(followSymlinkedDir('/var/p', '/private/var/p/lib', 'lib', ignore(), realpath)).toBe(true);
  });
});
