import { describe, expect, it, vi } from 'vitest';
import { rustPathItemsOr2015 } from '../../../src/extensions/resolution/rust-path-items-or-2015';

describe('rustPathItemsOr2015', () => {
  it('returns items found from the module without asking for the root', () => {
    const walk = vi.fn((_path: readonly string[], from: string): string[] | null =>
      from === 'module' ? ['local item'] : ['root item']);
    const crateRoot = vi.fn(() => 'root');

    expect(rustPathItemsOr2015(['util', 'item'], 'module', new Set(), walk, crateRoot)).toEqual(['local item']);
    expect(walk).toHaveBeenCalledTimes(1);
    expect(walk).toHaveBeenCalledWith(['util', 'item'], 'module');
    expect(crateRoot).not.toHaveBeenCalled();
  });

  it('falls back to the crate root for a bare head not found in the module', () => {
    const walk = vi.fn((_path: readonly string[], from: string): string[] | null =>
      from === 'root' ? ['root item'] : null);
    const crateRoot = vi.fn(() => 'root');

    expect(rustPathItemsOr2015(['util', 'item'], 'module', new Set(), walk, crateRoot)).toEqual(['root item']);
    expect(walk.mock.calls).toEqual([[['util', 'item'], 'module'], [['util', 'item'], 'root']]);
    expect(crateRoot).toHaveBeenCalledTimes(1);
  });

  it('does not fall back when the head is declared in pathMods', () => {
    const walk = vi.fn((_path: readonly string[], from: string): string[] | null =>
      from === 'root' ? ['root item'] : null);
    const crateRoot = vi.fn(() => 'root');

    expect(rustPathItemsOr2015(['util', 'item'], 'module', new Set(['util']), walk, crateRoot)).toBeNull();
    expect(walk).toHaveBeenCalledTimes(1);
    expect(crateRoot).not.toHaveBeenCalled();
  });

  it.each(['crate', 'self', 'super'])('does not fall back for the %s head', (head) => {
    const walk = vi.fn((_path: readonly string[], from: string): string[] | null =>
      from === 'root' ? ['root item'] : null);
    const crateRoot = vi.fn(() => 'root');

    expect(rustPathItemsOr2015([head, 'item'], 'module', new Set(), walk, crateRoot)).toBeNull();
    expect(walk).toHaveBeenCalledTimes(1);
    expect(crateRoot).not.toHaveBeenCalled();
  });

  it('returns null when no crate root is available', () => {
    const walk = vi.fn((_path: readonly string[], _from: string): string[] | null => null);
    const crateRoot = vi.fn((): string | null => null);

    expect(rustPathItemsOr2015(['util', 'item'], 'module', new Set(), walk, crateRoot)).toBeNull();
    expect(walk).toHaveBeenCalledTimes(1);
    expect(crateRoot).toHaveBeenCalledTimes(1);
  });

  it('returns null when neither module nor crate root finds items', () => {
    const walk = vi.fn((_path: readonly string[], _from: string): string[] | null => null);
    const crateRoot = vi.fn(() => 'root');

    expect(rustPathItemsOr2015(['util', 'item'], 'module', new Set(), walk, crateRoot)).toBeNull();
    expect(walk.mock.calls).toEqual([[['util', 'item'], 'module'], [['util', 'item'], 'root']]);
    expect(crateRoot).toHaveBeenCalledTimes(1);
  });

  it('treats an empty array from the module as a find', () => {
    const walk = vi.fn((_path: readonly string[], from: string): string[] | null =>
      from === 'module' ? [] : ['root item']);
    const crateRoot = vi.fn(() => 'root');

    expect(rustPathItemsOr2015(['util', 'item'], 'module', new Set(), walk, crateRoot)).toEqual([]);
    expect(walk).toHaveBeenCalledTimes(1);
    expect(crateRoot).not.toHaveBeenCalled();
  });
});
