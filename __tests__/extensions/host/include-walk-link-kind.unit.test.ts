import { describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { includeWalkLinkKind } from '../../../src/extensions/host/scan/include-walk-link-kind';

const root = '/var/p';
const link = '/var/p/ext';

function fsFor(target: string, targetKind: 'dir' | 'file' | 'other') {
  return {
    realpath(p: string): string {
      if (p === root) return '/private/var/p';
      if (p === link) return target;
      throw new Error(`unexpected realpath: ${p}`);
    },
    kind(p: string): 'dir' | 'file' | 'other' {
      if (p === link || p === target) return targetKind;
      throw new Error(`unexpected kind: ${p}`);
    },
  };
}

describe('includeWalkLinkKind', () => {
  it('walks a directory link whose target is inside the root', () => {
    expect(includeWalkLinkKind(root, link, 'ext', ignore(), fsFor('/private/var/p/lib', 'dir'))).toBe('dir');
  });

  it('skips an outside directory without a re-include', () => {
    expect(includeWalkLinkKind(root, link, 'ext', ignore(), fsFor('/outside/lib', 'dir'))).toBeNull();
  });

  it.each(['!ext', '!ext/'])('walks an outside directory re-included by %s', (rule) => {
    expect(includeWalkLinkKind(root, link, 'ext', ignore().add(rule), fsFor('/outside/lib', 'dir'))).toBe('dir');
  });

  it.each(['/private/var/p/lib.ts', '/outside/lib.ts'])(
    'considers a file link targeting %s', (target) => {
      expect(includeWalkLinkKind(root, link, 'ext', ignore(), fsFor(target, 'file'))).toBe('file');
    },
  );

  it('skips a target that is neither a directory nor a file', () => {
    expect(includeWalkLinkKind(root, link, 'ext', ignore(), fsFor('/outside/socket', 'other'))).toBeNull();
  });

  it('skips a broken link when realpath throws', () => {
    const fsOps = {
      ...fsFor('/outside/lib', 'dir'),
      realpath(p: string): string {
        if (p === root) return '/private/var/p';
        throw new Error('broken link');
      },
    };
    expect(includeWalkLinkKind(root, link, 'ext', ignore(), fsOps)).toBeNull();
  });

  it('skips an unreadable target when kind throws', () => {
    const fsOps = {
      ...fsFor('/outside/lib', 'dir'),
      kind(): 'dir' | 'file' | 'other' { throw new Error('unreadable'); },
    };
    expect(includeWalkLinkKind(root, link, 'ext', ignore(), fsOps)).toBeNull();
  });

  it('compares a target with the real path of the root', () => {
    expect(includeWalkLinkKind(root, link, 'ext', ignore(), fsFor('/private/var/p/lib', 'dir'))).toBe('dir');
  });

  it('treats a real prefix sibling as outside the root', () => {
    expect(includeWalkLinkKind('/var/p', '/var/p/ext', 'ext', ignore(), {
      realpath(p: string): string {
        if (p === '/var/p') return '/var/p';
        if (p === '/var/p/ext') return '/var/p2/x';
        throw new Error(`unexpected realpath: ${p}`);
      },
      kind(): 'dir' { return 'dir'; },
    })).toBeNull();
  });
});
