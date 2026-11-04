/**
 * Auto-seed note unit tests: the not-indexed note for a git worktree that codegraph could neither seed nor build
 * (`unseededWorktreeNote`, src/extensions/host/worktree-lifecycle/seed.ts) names the CODEGRAPH_NO_AUTO_SEED switch
 * and says to unset it to turn automatic indexing back on. Pure function: no index, no environment.
 * - U1: the note names CODEGRAPH_NO_AUTO_SEED, the variable that switches automatic indexing off.
 * - U2: the sentence that names the switch, or the sentence before or after it, tells the reader to unset it.
 * The guarantees builder-service.test.ts already pins on this note ("isn't indexed with codegraph", no
 * "user's decision") are not repeated here.
 */
import { describe, expect, it } from 'vitest';
import { unseededWorktreeNote } from '../../../src/extensions/host/worktree-lifecycle/seed';

const SWITCH = 'CODEGRAPH_NO_AUTO_SEED';

/**
 * The sentence that names the switch, with the sentence before it and the sentence after it. The instruction to
 * unset the switch must sit in one of these ("the same sentence or nearby"). Undefined when no sentence of the note
 * names the switch.
 */
function sentencesNearSwitch(note: string): string | undefined {
  const sentences = note.split(/(?<=[.!?])\s+/);
  const at = sentences.findIndex((sentence) => sentence.includes(SWITCH));
  if (at < 0) return undefined;
  return sentences.slice(Math.max(0, at - 1), at + 2).join(' ');
}

describe('unseededWorktreeNote names the automatic-indexing switch', () => {
  it('U1: names CODEGRAPH_NO_AUTO_SEED, the variable that turns automatic indexing off', () => {
    const note = unseededWorktreeNote('/w/sub', '/w');
    expect(note).toContain(SWITCH);
  });

  it('U2: tells the reader to unset CODEGRAPH_NO_AUTO_SEED to turn automatic indexing back on', () => {
    const note = unseededWorktreeNote('/w/sub', '/w');
    const near = sentencesNearSwitch(note);
    expect(
      near,
      `the note does not name ${SWITCH}, so there is no sentence in which to find an instruction to unset it`,
    ).toBeDefined();
    expect(near).toMatch(/unset/i);
  });
});
