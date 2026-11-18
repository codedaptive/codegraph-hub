import { describe, expect, it, vi } from 'vitest';
import { attempt } from '../../../src/extensions/host/builder/attempt';

describe('attempt', () => {
  it('swallows a throwing step so the next step runs', () => {
    const steps: string[] = [];
    attempt(() => { steps.push('first'); throw new Error('failed'); });
    attempt(() => { steps.push('second'); });
    expect(steps).toEqual(['first', 'second']);
  });

  it('runs a successful step once', () => {
    const step = vi.fn();
    attempt(step);
    expect(step).toHaveBeenCalledOnce();
  });
});
