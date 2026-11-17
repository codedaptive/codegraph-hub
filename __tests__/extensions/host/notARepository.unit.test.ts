import { describe, expect, it, vi } from 'vitest';

const modulePath = '../../../src/extensions/host/server/notARepository';

describe('notARepositoryAnswer', () => {
  it('returns null when the supplied lookup finds a worktree', async () => {
    const { notARepositoryAnswer } = await import(modulePath);
    const lookup = vi.fn(() => '/work/repo');
    expect(notARepositoryAnswer('/work/repo/src', lookup)).toBeNull();
    expect(lookup).toHaveBeenCalledWith('/work/repo/src');
  });

  it('returns success-shaped guidance for a path outside git', async () => {
    const { notARepositoryAnswer } = await import(modulePath);
    const lookup = vi.fn(() => null);
    const answer = notARepositoryAnswer('/work/plain', lookup);
    expect(lookup).toHaveBeenCalledWith('/work/plain');
    expect(answer).toEqual({ content: [{ type: 'text', text: expect.any(String) }] });
    const text = answer.content[0].text;
    expect(text.startsWith('/work/plain is not in a git repository')).toBe(true);
    expect(text).toMatch(/codegraph/i);
    expect(text).toMatch(/index/i);
    expect(text).toMatch(/answer/i);
    expect(text).toMatch(/(?:only|solely)/i);
    expect(text).toMatch(/worktree/i);
    expect(text).toMatch(/projectPath/);
    expect(text).toMatch(/(?:inside|within)/i);
    expect(text).toMatch(/built.in tools/i);
    expect(text).toMatch(/Read/);
    expect(text).toMatch(/Grep/);
    expect(text).toMatch(/Glob/);
    expect(text).toContain('codegraph init');
    expect(text).toContain('--no-git');
  });
});
