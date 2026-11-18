import { describe, expect, it, vi } from 'vitest';
import * as path from 'path';

const MODULE = path.resolve(__dirname, '../../../src/extensions/host/worktree-lifecycle/refuseReadOutsideRepository');

type Gate = (projectPath: string, printError: (message: string) => void, deps: {
  require: (p: string) => { root: string } | { refusal: string };
  exit: (code: number) => never;
}) => void;

async function loadGate(): Promise<Gate> {
  const mod = (await import(/* @vite-ignore */ MODULE)) as { refuseReadOutsideRepository: Gate };
  return mod.refuseReadOutsideRepository;
}

describe('refuseReadOutsideRepository', () => {
  it('prints the refusal exactly once and exits with status 1', async () => {
    const gate = await loadGate();
    const require = vi.fn(() => ({ refusal: 'a particular refusal' }));
    const printError = vi.fn();
    const stopped = new Error('exit');
    const exit = vi.fn((_code: number): never => { throw stopped; });

    expect(() => gate('/outside', printError, { require, exit })).toThrow(stopped);
    expect(require).toHaveBeenCalledExactlyOnceWith('/outside');
    expect(printError).toHaveBeenCalledExactlyOnceWith('a particular refusal');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(printError.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
  });

  it('returns without printing or exiting for an accepted root', async () => {
    const gate = await loadGate();
    const require = vi.fn(() => ({ root: '/accepted' }));
    const printError = vi.fn();
    const exit = vi.fn((_code: number): never => { throw new Error('unexpected exit'); });

    expect(gate('/accepted/child', printError, { require, exit })).toBeUndefined();
    expect(require).toHaveBeenCalledExactlyOnceWith('/accepted/child');
    expect(printError).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
