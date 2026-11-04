/**
 * Focus-note ceiling unit tests: the explore hard-ceiling cut, with and without the out-of-focus block.
 *
 * A focused explore answer carries a block of up to three lines (`outOfFocusBlock`), appended after the summary
 * line is filled in. The summary grows by at most `summaryGrowth` characters when that happens, and the block adds
 * its own length, so the final cut must leave room for both. With a non-empty block the cut targets a smaller
 * ceiling (`exploreCutLimits`). With an empty block the limits are the hard ceiling itself.
 *
 * Pure functions only, no index and no stdio: `exploreCutLimits` sizes the cut and `cutExploreToCeiling` makes it.
 * Every answer here is a synthetic string. H is the hard ceiling of the smallest budget tier (maxOutputChars 13,000
 * times 1.5, tools.ts hardCeiling). The block is the three-line block the production builds, about 320 characters.
 *
 * - C0: a non-empty block sets the ceiling H - block - growth, and the slice limit the longer truncation note below it.
 * - C1: a long sectioned answer cut with the block fits H with the growth and the block added. Cut at the
 *   empty-block limits the same answer overshoots H once the block and the growth are added.
 * - C1t: the same, when the surviving text carries a trimmed section: the trimmed note is used and the answer fits.
 * - C2: an epilogue-only cut that fits H but not H - block - growth is not used when a block is present, and the
 *   answer fits. At the empty-block limits that epilogue-only cut is used and overshoots.
 * - C2b: an epilogue-only cut that fits the smaller ceiling is kept, with its cut note.
 * - C3: an empty block gives the limits H and H, and the cuts are the empty-block arithmetic's: the section cut
 *   and the epilogue-only cut.
 * - C4: an answer no longer than the ceiling is returned unchanged, with or without an epilogue-only cut.
 * - C4b: one character over the ceiling is cut.
 */
import { describe, expect, it } from 'vitest';
import { EXPLORE_FALLBACK_NOTES, cutExploreToCeiling, exploreCutLimits } from '../../../src/mcp/tools';

/** The explore hard ceiling of the smallest budget tier: maxOutputChars 13,000 times 1.5. */
const H = 19_500;
/**
 * A fixed stand-in for the summary line's growth. A focus note for one directory (`src/app`) is 97 characters on its
 * own, and a pinned file adds more, so a real growth can exceed this.
 */
const GROWTH = 100;
/** The length of each file section in the synthetic answers. */
const SECTION = 1_000;
const NEVER_TRIMMED = (): boolean => false;
const ALWAYS_TRIMMED = (): boolean => true;

/** The focus line for `name`: the name in backticks, then the sentence, on one line. */
function focusLine(name: string): string {
  return `\`${name}\` is defined in this index, outside this session's focus; pass scope: "repo" to include it.`;
}

/**
 * The block the production appends after the summary (`outOfFocusBlock`): a blank line, then one line per name.
 * Three names, so about 320 characters.
 */
const BLOCK = `\n\n${['widgetHelper01', 'widgetHelper02', 'widgetHelper03'].map(focusLine).join('\n')}`;
/** The ceiling the cut targets with the block present: H less the block and the growth. */
const CEILING_WITH_BLOCK = H - BLOCK.length - GROWTH;

/**
 * `total` characters of file sections. Section k is SECTION characters long and starts at offset k * SECTION, with
 * its file header at the start of a line. So "\n**`" (the boundary the cut looks for) sits at every multiple of
 * SECTION from SECTION on. The filler holds no line break, so the cut takes the last such header in a slice as its
 * boundary.
 */
function sectioned(total: number): string {
  let out = '';
  for (let k = 0; out.length < total; k++) {
    const separator = k === 0 ? '' : '\n';
    const header = `${separator}**\`src/lib/widget${String(k).padStart(2, '0')}.ts\`**\n`;
    out += header + 'x'.repeat(SECTION - header.length);
  }
  return out.slice(0, total);
}

/** A trailing pointer list of `lines` lines: the shape of the epilogue that follows the sections. */
function pointerTail(lines: number): string {
  const rows = Array.from({ length: lines }, (_, i) => {
    const nn = String(i).padStart(2, '0');
    return `- src/lib/widget${nn}.ts: widgetHelper${nn}:2, buildWidget${nn}:1`;
  });
  return `\n${rows.join('\n')}`;
}

/** cutExploreToCeiling with the given limits, for an answer whose epilogue-only cut is `epilogueOnlyCut`. */
function cutWith(
  output: string,
  epilogueOnlyCut: string | null,
  limits: { ceiling: number; sliceLimit: number },
  trimmedIn: (text: string) => boolean = NEVER_TRIMMED,
): string {
  return cutExploreToCeiling({ output, epilogueOnlyCut, ceiling: limits.ceiling, sliceLimit: limits.sliceLimit, trimmedIn });
}

describe('focus note ceiling: the explore cut leaves room for the out-of-focus block', () => {
  it('C0: a non-empty block sets the ceiling H - block - growth, and the slice limit the longer truncation note below it', () => {
    const longest = Math.max(
      EXPLORE_FALLBACK_NOTES.truncated.complete.length,
      EXPLORE_FALLBACK_NOTES.truncated.trimmed.length,
    );
    expect(exploreCutLimits(H, BLOCK.length, GROWTH)).toEqual({
      ceiling: H - BLOCK.length - GROWTH,
      sliceLimit: H - BLOCK.length - GROWTH - longest,
    });
  });

  it('C1: a long sectioned answer cut with the block fits H with the growth and the block added; at the empty-block limits it overshoots', () => {
    const output = sectioned(25_000);
    expect(output.length, 'C1 premise: the answer is over the block ceiling').toBeGreaterThan(CEILING_WITH_BLOCK);

    const result = cutWith(output, null, exploreCutLimits(H, BLOCK.length, GROWTH));
    const emptyBlock = cutWith(output, null, exploreCutLimits(H, 0, GROWTH));

    // The cut keeps sections 0 to 17: section 18 starts at 18,000, the last boundary at or below the slice limit.
    expect(result, 'C1: the cut keeps the sections whole, then the truncated note').toBe(
      output.slice(0, 18 * SECTION) + EXPLORE_FALLBACK_NOTES.truncated.complete,
    );
    expect(result.length + GROWTH + BLOCK.length, 'C1: the answer with its growth and block fits H').toBeLessThanOrEqual(H);
    expect(emptyBlock.length + GROWTH + BLOCK.length, 'C1: the same cut at the empty-block limits overshoots H once the block is added')
      .toBeGreaterThan(H);
  });

  it('C1t: with a trimmed survivor the trimmed truncation note is used, and the answer still fits', () => {
    const output = sectioned(25_000);

    const result = cutWith(output, null, exploreCutLimits(H, BLOCK.length, GROWTH), ALWAYS_TRIMMED);

    expect(result, 'C1t: the cut takes the trimmed note').toBe(output.slice(0, 18 * SECTION) + EXPLORE_FALLBACK_NOTES.truncated.trimmed);
    expect(result.length + GROWTH + BLOCK.length, 'C1t: the answer with its growth and block fits H').toBeLessThanOrEqual(H);
  });

  it('C2: an epilogue-only cut that fits H but not H - block - growth is not used with a block, and the answer fits; at the empty-block limits it is used and overshoots', () => {
    const epilogueOnlyCut = sectioned(19_000);
    const cutNote = EXPLORE_FALLBACK_NOTES.cut.complete;
    const output = epilogueOnlyCut + pointerTail(12);
    // Premises: the answer is over H, and the epilogue-only cut with its note fits H but not the block ceiling.
    expect(output.length, 'C2 premise: the answer is over H').toBeGreaterThan(H);
    expect(epilogueOnlyCut.length + cutNote.length, 'C2 premise: the epilogue-only cut fits H').toBeLessThanOrEqual(H);
    expect(epilogueOnlyCut.length + cutNote.length, 'C2 premise: the epilogue-only cut is over the block ceiling')
      .toBeGreaterThan(CEILING_WITH_BLOCK);

    const result = cutWith(output, epilogueOnlyCut, exploreCutLimits(H, BLOCK.length, GROWTH));
    const emptyBlock = cutWith(output, epilogueOnlyCut, exploreCutLimits(H, 0, GROWTH));

    expect(result, 'C2: with the block the cut falls to the section boundary').toBe(
      output.slice(0, 18 * SECTION) + EXPLORE_FALLBACK_NOTES.truncated.complete,
    );
    expect(result.length + GROWTH + BLOCK.length, 'C2: the answer with its growth and block fits H').toBeLessThanOrEqual(H);
    expect(emptyBlock, 'C2: at the empty-block limits the epilogue-only cut is used').toBe(epilogueOnlyCut + cutNote);
    expect(emptyBlock.length + GROWTH + BLOCK.length, 'C2: the epilogue-only cut overshoots H once the block is added').toBeGreaterThan(H);
  });

  it('C2b: an epilogue-only cut that fits the smaller ceiling is kept, with its cut note', () => {
    const epilogueOnlyCut = sectioned(18_000);
    const output = epilogueOnlyCut + pointerTail(25);
    expect(output.length, 'C2b premise: the answer is over the block ceiling').toBeGreaterThan(CEILING_WITH_BLOCK);
    expect(epilogueOnlyCut.length + EXPLORE_FALLBACK_NOTES.cut.complete.length, 'C2b premise: the cut fits the block ceiling')
      .toBeLessThanOrEqual(CEILING_WITH_BLOCK);

    const result = cutWith(output, epilogueOnlyCut, exploreCutLimits(H, BLOCK.length, GROWTH));

    expect(result, 'C2b: the epilogue-only cut is kept, with the cut note').toBe(epilogueOnlyCut + EXPLORE_FALLBACK_NOTES.cut.complete);
    expect(result.length + GROWTH + BLOCK.length, 'C2b: the answer with its growth and block fits H').toBeLessThanOrEqual(H);
  });

  it('C3: an empty block gives the limits H and H; the cuts are the section cut and the epilogue-only cut of that arithmetic', () => {
    const limits = exploreCutLimits(H, 0, GROWTH);
    expect(limits, 'C3: an empty block gives H and H').toEqual({ ceiling: H, sliceLimit: H });
    expect(exploreCutLimits(H, 0, 0), 'C3: with no growth either, an empty block still gives H and H').toEqual({ ceiling: H, sliceLimit: H });

    // The section cut: the cut is at H, its last section boundary is 19,000, and the sections before it are kept.
    const sections = sectioned(25_000);
    expect(cutWith(sections, null, limits), 'C3: the section cut keeps sections 0 to 18').toBe(
      sections.slice(0, 19 * SECTION) + EXPLORE_FALLBACK_NOTES.truncated.complete,
    );

    // The epilogue-only cut: 19,000 characters of sections, with the cut note, fit H, so that cut is used.
    const epilogueOnlyCut = sectioned(19_000);
    const output = epilogueOnlyCut + pointerTail(12);
    expect(output.length, 'C3 premise: the answer is over H').toBeGreaterThan(H);
    expect(cutWith(output, epilogueOnlyCut, limits), 'C3: the epilogue-only cut is used').toBe(
      epilogueOnlyCut + EXPLORE_FALLBACK_NOTES.cut.complete,
    );
  });

  it('C4: an answer no longer than the ceiling is returned unchanged, with or without an epilogue-only cut', () => {
    const withBlock = exploreCutLimits(H, BLOCK.length, GROWTH);
    const emptyBlock = exploreCutLimits(H, 0, GROWTH);
    // Exactly at each ceiling: not over, so not cut.
    const atWithBlock = sectioned(CEILING_WITH_BLOCK);
    const atEmptyBlock = sectioned(H);
    const short = sectioned(3_000);

    expect(cutWith(atWithBlock, atWithBlock.slice(0, 5_000), withBlock), 'C4: at the block ceiling the answer is unchanged').toBe(atWithBlock);
    expect(cutWith(atEmptyBlock, atEmptyBlock.slice(0, 5_000), emptyBlock), 'C4: at H the answer is unchanged').toBe(atEmptyBlock);
    expect(cutWith(short, null, withBlock), 'C4: a short answer is unchanged with a block').toBe(short);
    expect(cutWith(short, null, emptyBlock), 'C4: a short answer is unchanged with an empty block').toBe(short);
  });

  it('C4b: one character over the ceiling is cut, with the block and with an empty block', () => {
    const over = sectioned(CEILING_WITH_BLOCK + 1);
    const result = cutWith(over, null, exploreCutLimits(H, BLOCK.length, GROWTH));
    expect(result, 'C4b: one over the block ceiling is cut').not.toBe(over);
    expect(result.length + GROWTH + BLOCK.length, 'C4b: the cut answer fits H with the growth and block').toBeLessThanOrEqual(H);

    const overEmpty = sectioned(H + 1);
    expect(cutWith(overEmpty, null, exploreCutLimits(H, 0, GROWTH)), 'C4b: one over H with an empty block is cut').not.toBe(overEmpty);
  });
});
