import { describe, expect, it, vi } from 'vitest';
import { isDeadHolderRecord } from '../../../src/extensions/host/worktree-lifecycle/isDeadHolderRecord';

describe('isDeadHolderRecord', () => {
  it('treats an undecodable holder as dead', () => {
    const alive = vi.fn(() => true);
    expect(isDeadHolderRecord(null, 42, alive)).toBe(true);
    expect(alive).not.toHaveBeenCalled();
  });

  it.each([0, -1])('treats nonpositive pid %i as dead without checking liveness', (pid) => {
    const alive = vi.fn(() => true);
    expect(isDeadHolderRecord({ pid }, 42, alive)).toBe(true);
    expect(alive).not.toHaveBeenCalled();
  });

  it('treats its own pid as live even if the liveness check would fail', () => {
    const alive = vi.fn(() => false);
    expect(isDeadHolderRecord({ pid: 42 }, 42, alive)).toBe(false);
  });

  it('treats another live pid as live', () => {
    const alive = vi.fn(() => true);
    expect(isDeadHolderRecord({ pid: 43 }, 42, alive)).toBe(false);
    expect(alive).toHaveBeenCalledWith(43);
  });

  it('treats another dead pid as dead', () => {
    const alive = vi.fn(() => false);
    expect(isDeadHolderRecord({ pid: 43 }, 42, alive)).toBe(true);
    expect(alive).toHaveBeenCalledWith(43);
  });
});
