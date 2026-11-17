import { describe, expect, it, vi } from 'vitest';
import ignore from 'ignore';
import { filesUnderReincludedLinks } from '../../../src/extensions/host/scan/files-under-reincluded-links';

type EntryKind = 'dir' | 'file' | 'link' | 'other';
type Node = {
  kind: 'dir' | 'file' | 'other';
  link?: boolean;
  real?: string | Error;
  entries?: Array<{ name: string; kind: EntryKind }> | Error;
};

function fakeFs(nodes: Record<string, Node>) {
  function node(path: string): Node {
    const result = nodes[path];
    if (!result) throw new Error(`missing: ${path}`);
    return result;
  }
  return {
    isLink: vi.fn((path: string) => nodes[path]?.link ?? false),
    realpath(path: string): string {
      const value = node(path).real;
      if (value instanceof Error) throw value;
      return value ?? path;
    },
    kind(path: string): 'dir' | 'file' | 'other' {
      return node(path).kind;
    },
    readdir(path: string): Array<{ name: string; kind: EntryKind }> {
      const entries = node(path).entries;
      if (!entries || entries instanceof Error) throw entries ?? new Error(`unreadable: ${path}`);
      return entries;
    },
  };
}

function fixture(extra: Record<string, Node> = {}) {
  return fakeFs({
    '/repo': { kind: 'dir' },
    '/repo/data/runs': {
      kind: 'dir', link: true, real: '/outside/runs',
      entries: [{ name: 'x.ts', kind: 'file' }, { name: 'sub', kind: 'dir' }],
    },
    '/repo/data/runs/sub': {
      kind: 'dir', real: '/outside/runs/sub', entries: [{ name: 'y.ts', kind: 'file' }],
    },
    ...extra,
  });
}

const all = () => true;
const rules = (...patterns: string[]) => ignore().add(patterns);

describe('filesUnderReincludedLinks', () => {
  it('walks an outside listed directory link re-included by path', () => {
    const result = filesUnderReincludedLinks('/repo', ['data/runs'], rules('!data/runs'), all, fixture());
    expect(result.sort()).toEqual(['data/runs/sub/y.ts', 'data/runs/x.ts']);
  });

  it('does not walk an outside link without a re-include rule', () => {
    expect(filesUnderReincludedLinks('/repo', ['data/runs'], rules(), all, fixture())).toEqual([]);
  });

  it('walks an outside link re-included by directory form', () => {
    const result = filesUnderReincludedLinks('/repo', ['data/runs'], rules('!data/runs/'), all, fixture());
    expect(result.sort()).toEqual(['data/runs/sub/y.ts', 'data/runs/x.ts']);
  });

  it('does not follow a re-included link into the root', () => {
    const fs = fixture({ '/repo/lib': { kind: 'dir', link: true, real: '/repo/vendor-real', entries: [{ name: 'x.ts', kind: 'file' }] } });
    expect(filesUnderReincludedLinks('/repo', ['lib'], rules('!lib'), all, fs)).toEqual([]);
  });

  it('drops listed non-links and links to files', () => {
    const fs = fixture({
      '/repo/plain': { kind: 'dir', entries: [{ name: 'x.ts', kind: 'file' }] },
      '/repo/file-link': { kind: 'file', link: true, real: '/outside/file.ts' },
    });
    expect(filesUnderReincludedLinks('/repo', ['plain', 'file-link'], rules('!plain', '!file-link'), all, fs)).toEqual([]);
  });

  it('checks link status only for listed paths matched by a negation', () => {
    const fs = fixture();
    expect(filesUnderReincludedLinks('/repo', ['unmatched', 'data/runs'], rules('!data/runs'), all, fs).sort())
      .toEqual(['data/runs/sub/y.ts', 'data/runs/x.ts']);
    expect(fs.isLink.mock.calls).toEqual([['/repo/data/runs']]);
  });

  it('prunes directories rejected by keep', () => {
    const keep = (rel: string, isDir: boolean) => !(isDir && rel === 'data/runs/sub');
    expect(filesUnderReincludedLinks('/repo', ['data/runs'], rules('!data/runs'), keep, fixture()))
      .toEqual(['data/runs/x.ts']);
  });

  it('drops files rejected by keep', () => {
    const keep = (rel: string, isDir: boolean) => isDir || rel !== 'data/runs/x.ts';
    expect(filesUnderReincludedLinks('/repo', ['data/runs'], rules('!data/runs'), keep, fixture()))
      .toEqual(['data/runs/sub/y.ts']);
  });

  it('skips .git and .codegraph directories inside a walked link', () => {
    const fs = fixture({
      '/repo/data/runs': { kind: 'dir', link: true, real: '/outside/runs', entries: [
        { name: '.git', kind: 'dir' }, { name: '.codegraph', kind: 'dir' }, { name: 'x.ts', kind: 'file' },
      ] },
      '/repo/data/runs/.git': { kind: 'dir', entries: [{ name: 'hidden.ts', kind: 'file' }] },
      '/repo/data/runs/.codegraph': { kind: 'dir', entries: [{ name: 'hidden.ts', kind: 'file' }] },
    });
    expect(filesUnderReincludedLinks('/repo', ['data/runs'], rules('!data/runs'), all, fs)).toEqual(['data/runs/x.ts']);
  });

  it('does not follow a nested directory link back inside the root', () => {
    const fs = fixture({
      '/repo/data/runs': { kind: 'dir', link: true, real: '/outside/runs', entries: [{ name: 'inside', kind: 'link' }] },
      '/repo/data/runs/inside': { kind: 'dir', link: true, real: '/repo/lib', entries: [{ name: 'x.ts', kind: 'file' }] },
    });
    expect(filesUnderReincludedLinks('/repo', ['data/runs'], rules('!data/runs', '!data/runs/inside'), all, fs)).toEqual([]);
  });

  it('follows a nested outside directory link when its own path is re-included', () => {
    const fs = fixture({
      '/repo/data/runs': { kind: 'dir', link: true, real: '/outside/runs', entries: [{ name: 'more', kind: 'link' }] },
      '/repo/data/runs/more': { kind: 'dir', link: true, real: '/elsewhere/more', entries: [{ name: 'z.ts', kind: 'file' }] },
    });
    expect(filesUnderReincludedLinks('/repo', ['data/runs'], rules('!data/runs', '!data/runs/more'), all, fs))
      .toEqual(['data/runs/more/z.ts']);
  });

  it('does not follow a nested outside directory link without its own re-include', () => {
    const fs = fixture({
      '/repo/data/runs': { kind: 'dir', link: true, real: '/outside/runs', entries: [{ name: 'more', kind: 'link' }] },
      '/repo/data/runs/more': { kind: 'dir', link: true, real: '/elsewhere/more', entries: [{ name: 'z.ts', kind: 'file' }] },
    });
    expect(filesUnderReincludedLinks('/repo', ['data/runs'], rules('!data/runs'), all, fs)).toEqual([]);
  });

  it('returns nested file links subject to keep', () => {
    const fs = fixture({
      '/repo/data/runs': { kind: 'dir', link: true, real: '/outside/runs', entries: [
        { name: 'keep.ts', kind: 'link' }, { name: 'drop.ts', kind: 'link' },
      ] },
      '/repo/data/runs/keep.ts': { kind: 'file', link: true, real: '/elsewhere/keep.ts' },
      '/repo/data/runs/drop.ts': { kind: 'file', link: true, real: '/elsewhere/drop.ts' },
    });
    const keep = (rel: string, isDir: boolean) => isDir || rel !== 'data/runs/drop.ts';
    expect(filesUnderReincludedLinks('/repo', ['data/runs'], rules('!data/runs'), keep, fs))
      .toEqual(['data/runs/keep.ts']);
  });

  it('skips a broken nested link and keeps other files', () => {
    const fs = fixture({
      '/repo/data/runs': { kind: 'dir', link: true, real: '/outside/runs', entries: [
        { name: 'broken', kind: 'link' }, { name: 'x.ts', kind: 'file' },
      ] },
      '/repo/data/runs/broken': { kind: 'dir', link: true, real: new Error('broken') },
    });
    expect(filesUnderReincludedLinks('/repo', ['data/runs'], rules('!data/runs', '!data/runs/broken'), all, fs))
      .toEqual(['data/runs/x.ts']);
  });

  it('does not walk an already visited real directory through a nested cycle', () => {
    const fs = fixture({
      '/repo/data/runs': { kind: 'dir', link: true, real: '/outside/runs', entries: [
        { name: 'x.ts', kind: 'file' }, { name: 'again', kind: 'link' },
      ] },
      '/repo/data/runs/again': { kind: 'dir', link: true, real: '/outside/runs', entries: [
        { name: 'x.ts', kind: 'file' }, { name: 'again', kind: 'link' },
      ] },
    });
    expect(filesUnderReincludedLinks('/repo', ['data/runs'], rules('!data/runs', '!data/runs/again'), all, fs))
      .toEqual(['data/runs/x.ts']);
  });

  it('skips an unreadable directory and keeps its readable siblings', () => {
    const fs = fixture({
      '/repo/data/runs': { kind: 'dir', link: true, real: '/outside/runs', entries: [
        { name: 'unreadable', kind: 'dir' }, { name: 'x.ts', kind: 'file' },
      ] },
      '/repo/data/runs/unreadable': { kind: 'dir', real: '/outside/runs/unreadable', entries: new Error('denied') },
    });
    expect(filesUnderReincludedLinks('/repo', ['data/runs'], rules('!data/runs'), all, fs)).toEqual(['data/runs/x.ts']);
  });

  it('skips listed links whose realpath or kind cannot be read', () => {
    const fs = fixture({
      '/repo/broken': { kind: 'dir', link: true, real: new Error('broken') },
      '/repo/unreadable': { kind: 'dir', link: true, real: '/outside/unreadable' },
    });
    const originalKind = fs.kind;
    fs.kind = (path: string) => {
      if (path === '/repo/unreadable') throw new Error('denied');
      return originalKind(path);
    };
    expect(filesUnderReincludedLinks('/repo', ['broken', 'unreadable', 'data/runs'],
      rules('!broken', '!unreadable', '!data/runs'), all, fs).sort())
      .toEqual(['data/runs/sub/y.ts', 'data/runs/x.ts']);
  });

  it('compares targets against the real path of rootDir', () => {
    const fs = fakeFs({
      '/var/p': { kind: 'dir', real: '/private/var/p' },
      '/var/p/lib': { kind: 'dir', link: true, real: '/private/var/p/lib', entries: [{ name: 'x.ts', kind: 'file' }] },
    });
    expect(filesUnderReincludedLinks('/var/p', ['lib'], rules('!lib'), all, fs)).toEqual([]);
  });
});
