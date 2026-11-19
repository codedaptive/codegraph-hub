import { describe, expect, it, vi } from 'vitest';
import { rustHeadUse } from '../../../src/extensions/resolution/rust-head-use';

/** The binding rustHeadUse returns, as its fakes for `visible` must shape it. */
type RustHeadBinding = NonNullable<ReturnType<typeof rustHeadUse>>;

describe('rustHeadUse', () => {
  it('expands local aliases and preserves the first binding block', () => {
    const visible = (name: string, at: number): RustHeadBinding | undefined => {
      if (name === 'a' && at === 70) return { paths: [{ segs: ['b'], at: 50 }], std: [], block: 40 };
      if (name === 'b' && at === 50) return { paths: [{ segs: ['crate', 'shadow', 'a'], at: 20 }], std: [], block: 10 };
      return undefined;
    };

    expect(rustHeadUse('a', 70, true, visible, [], null)).toEqual({
      paths: [{ segs: ['crate', 'shadow', 'a'], at: 20 }], std: [], block: 40,
    });
  });

  it('looks up each alias at its import site, not at the reference', () => {
    const visible = vi.fn((name: string, at: number): RustHeadBinding | undefined => {
      if (name === 'a' && at === 70) return { paths: [{ segs: ['b'], at: 50 }], std: [], block: 40 };
      if (name === 'b' && at === 50) return { paths: [{ segs: ['crate', 'shadow', 'a'], at: 20 }], std: [], block: 10 };
      if (name === 'b' && at === 62) return { paths: [{ segs: ['crate', 'shadow', 'b'], at: 61 }], std: [], block: 60 };
      return undefined;
    });

    expect(rustHeadUse('a', 70, true, visible, [], null)).toEqual({
      paths: [{ segs: ['crate', 'shadow', 'a'], at: 20 }], std: [], block: 40,
    });
    expect(visible).toHaveBeenCalledWith('b', 50);
  });

  it('declines a local binding shadowed by a nearer mod', () => {
    const from = {};
    const visible = () => ({ paths: [{ segs: ['crate', 'near', 'a'], at: 20 }], std: [], block: 10 });
    expect(rustHeadUse('b', 80, true, visible, [
      { name: 'b', scope: { open: 30, close: 90 }, parent: from },
    ], from)).toBeNull();
  });

  it('expands a local binding when no nearer mod exists', () => {
    const visible = () => ({ paths: [{ segs: ['crate', 'near', 'a'], at: 20 }], std: [], block: 10 });
    expect(rustHeadUse('b', 80, true, visible, [], null)).toEqual({
      paths: [{ segs: ['crate', 'near', 'a'], at: 20 }], std: [], block: 10,
    });
  });

  it('declines a block-local mod even without a use binding', () => {
    const from = {};
    expect(rustHeadUse('a', 50, true, () => undefined, [
      { name: 'a', scope: { open: 5, close: 100 }, parent: from },
    ], from)).toBeNull();
  });

  it('ignores a mod belonging to another inline module', () => {
    expect(rustHeadUse('a', 50, true, () => undefined, [
      { name: 'a', scope: { open: 5, close: 100 }, parent: {} },
    ], {})).toBeUndefined();
  });

  it('ignores a module-level use binding', () => {
    expect(rustHeadUse('a', 50, true, () => ({
      paths: [{ segs: ['crate', 'a'], at: 20 }], std: [], block: -1,
    }), [], null)).toBeUndefined();
  });

  it('declines a std-only binding', () => {
    expect(rustHeadUse('a', 50, false, () => ({ paths: [], std: [{}], block: 10 }), [], null)).toBeNull();
  });

  it('returns the first local binding without following when disabled', () => {
    const visible = (name: string): RustHeadBinding | undefined => name === 'a'
      ? { paths: [{ segs: ['b'], at: 50 }], std: [], block: 40 }
      : { paths: [{ segs: ['crate', 'shadow', 'a'], at: 20 }], std: [], block: 10 };
    expect(rustHeadUse('a', 70, false, visible, [], null)).toEqual({
      paths: [{ segs: ['b'], at: 50 }], std: [], block: 40,
    });
  });

  it('keeps an inner use over an outer mod without following', () => {
    const visible = () => ({ paths: [{ segs: ['crate', 'Concrete'], at: 50 }], std: [], block: 40 });
    expect(rustHeadUse('Alias', 70, false, visible, [
      { name: 'Alias', scope: { open: 10, close: 100 }, parent: null },
    ], null)).toEqual({ paths: [{ segs: ['crate', 'Concrete'], at: 50 }], std: [], block: 40 });
  });

  it('keeps an inner split-path use over an outer mod when following', () => {
    const visible = () => ({
      paths: [{ segs: ['crate', 'x'], at: 50 }, { segs: ['crate', 'y'], at: 55 }], std: [], block: 40,
    });
    expect(rustHeadUse('Alias', 70, true, visible, [
      { name: 'Alias', scope: { open: 10, close: 100 }, parent: null },
    ], null)).toEqual({
      paths: [{ segs: ['crate', 'x'], at: 50 }, { segs: ['crate', 'y'], at: 55 }], std: [], block: 40,
    });
  });

  it('declines a mod in a block nearer than the use without following', () => {
    const visible = () => ({ paths: [{ segs: ['crate', 'Concrete'], at: 50 }], std: [], block: 40 });
    expect(rustHeadUse('Alias', 70, false, visible, [
      { name: 'Alias', scope: { open: 60, close: 100 }, parent: null },
    ], null)).toBeNull();
  });

  it('keeps the path of a plain self-binding without following it through itself', () => {
    const visible = (name: string, at: number): RustHeadBinding | undefined =>
      name === 'a' && (at === 70 || at === 20)
        ? { paths: [{ segs: ['a'], at: 20 }], std: [], block: 10 }
        : undefined;
    expect(rustHeadUse('a', 70, true, visible, [], null)).toEqual({
      paths: [{ segs: ['a'], at: 20 }], std: [], block: 10,
    });
  });

  it('declines a self-binding use under an outer mod of its name', () => {
    const from = {};
    const visible = (name: string, at: number): RustHeadBinding | undefined =>
      name === 'a' && (at === 70 || at === 20)
        ? { paths: [{ segs: ['a'], at: 20 }], std: [], block: 30 }
        : undefined;
    expect(rustHeadUse('a', 70, true, visible, [
      { name: 'a', scope: { open: 10, close: 100 }, parent: from },
    ], from)).toBeNull();
  });

  it('keeps the tail of a self-binding without repeatedly expanding it', () => {
    const visible = (name: string, at: number): RustHeadBinding | undefined =>
      name === 'a' && (at === 70 || at === 20)
        ? { paths: [{ segs: ['a', 'c'], at: 20 }], std: [], block: 10 }
        : undefined;
    expect(rustHeadUse('a', 70, true, visible, [], null)).toEqual({
      paths: [{ segs: ['a', 'c'], at: 20 }], std: [], block: 10,
    });
  });

  it('declines an alias cycle', () => {
    const visible = (name: string, at: number): RustHeadBinding | undefined => {
      if (name === 'a' && (at === 70 || at === 30)) return { paths: [{ segs: ['b'], at: 20 }], std: [], block: 10 };
      if (name === 'b' && at === 20) return { paths: [{ segs: ['a'], at: 30 }], std: [], block: 10 };
      return undefined;
    };
    expect(rustHeadUse('a', 70, true, visible, [], null)).toBeNull();
  });

  it('returns differing paths on the first binding unchanged', () => {
    expect(rustHeadUse('a', 70, true, () => ({
      paths: [{ segs: ['b'], at: 30 }, { segs: ['c'], at: 40 }], std: [], block: 10,
    }), [], null)).toEqual({
      paths: [{ segs: ['b'], at: 30 }, { segs: ['c'], at: 40 }], std: [], block: 10,
    });
  });

  it('declines differing paths on a later binding', () => {
    const visible = (name: string): RustHeadBinding | undefined => name === 'a'
      ? { paths: [{ segs: ['b'], at: 50 }], std: [], block: 40 }
      : { paths: [{ segs: ['crate', 'x'], at: 20 }, { segs: ['crate', 'y'], at: 30 }], std: [], block: 10 };
    expect(rustHeadUse('a', 70, true, visible, [], null)).toBeNull();
  });

  it('keeps remaining segments while expanding multiple aliases', () => {
    const visible = (name: string): RustHeadBinding | undefined => {
      if (name === 'a') return { paths: [{ segs: ['b', 'tail'], at: 50 }], std: [], block: 40 };
      if (name === 'b') return { paths: [{ segs: ['crate', 'root'], at: 20 }], std: [], block: 10 };
      return undefined;
    };
    expect(rustHeadUse('a', 70, true, visible, [], null)).toEqual({
      paths: [{ segs: ['crate', 'root', 'tail'], at: 20 }], std: [], block: 40,
    });
  });

  it('declines when a later alias resolves only to std', () => {
    const visible = (name: string): RustHeadBinding | undefined => name === 'a'
      ? { paths: [{ segs: ['b'], at: 50 }], std: [], block: 40 }
      : { paths: [], std: [{}], block: 10 };
    expect(rustHeadUse('a', 70, true, visible, [], null)).toBeNull();
  });

  it('declines a nearer mod at the alias import site', () => {
    const from = {};
    const visible = (name: string): RustHeadBinding | undefined => name === 'a'
      ? { paths: [{ segs: ['b'], at: 50 }], std: [], block: 40 }
      : { paths: [{ segs: ['crate', 'x'], at: 20 }], std: [], block: 10 };
    expect(rustHeadUse('a', 70, true, visible, [
      { name: 'b', scope: { open: 30, close: 60 }, parent: from },
    ], from)).toBeNull();
  });

  it('still checks for a nearer mod when following is disabled', () => {
    const from = {};
    expect(rustHeadUse('a', 70, false, () => ({
      paths: [{ segs: ['b'], at: 50 }], std: [], block: 10,
    }), [{ name: 'a', scope: { open: 30, close: 90 }, parent: from }], from)).toBeNull();
  });

  it('ignores mods outside the reference scope and module-level mods', () => {
    const from = {};
    expect(rustHeadUse('a', 50, false, () => undefined, [
      { name: 'a', scope: { open: 5, close: 40 }, parent: from },
      { name: 'a', scope: { open: 50, close: 100 }, parent: from },
      { name: 'a', parent: from },
      { name: 'b', scope: { open: 5, close: 100 }, parent: from },
    ], from)).toBeUndefined();
  });

  it.each(['crate', 'self', 'super'])('stops following at the %s path root', (root) => {
    const visible = vi.fn((name: string): RustHeadBinding | undefined => name === 'a'
      ? { paths: [{ segs: [root, 'item'], at: 20 }], std: [], block: 10 }
      : { paths: [], std: [{}], block: 1 });
    expect(rustHeadUse('a', 50, true, visible, [], null)).toEqual({
      paths: [{ segs: [root, 'item'], at: 20 }], std: [], block: 10,
    });
    expect(visible).not.toHaveBeenCalledWith(root, 20);
  });

  it('keeps the final path metadata while expanding', () => {
    const visible = (name: string) => name === 'a'
      ? { paths: [{ segs: ['b', 'tail'], at: 50, tag: 'first' }], std: [], block: 40 }
      : { paths: [{ segs: ['crate', 'root'], at: 20, tag: 'last' }], std: [], block: 10 };
    expect(rustHeadUse('a', 70, true, visible, [], null)).toEqual({
      paths: [{ segs: ['crate', 'root', 'tail'], at: 20, tag: 'last' }], std: [], block: 40,
    });
  });
});
