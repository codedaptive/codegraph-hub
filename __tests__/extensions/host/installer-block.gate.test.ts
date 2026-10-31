/**
 * The CodeGraph block the installer writes into user-scope instruction files
 * (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ...). Those files apply to every
 * project the user opens, so the block must not carry the phrases that told
 * agents to skip CodeGraph or called indexing the user's decision. It must
 * still name the MCP tool and the CLI command, the two surfaces that
 * subagents and non-MCP agents use.
 *
 * These are pure string checks on the exported constants: nothing is
 * installed and no file is read.
 */
import { describe, it, expect } from 'vitest';
import {
  CODEGRAPH_INSTRUCTIONS_BLOCK,
  CODEGRAPH_SECTION_START,
  CODEGRAPH_SECTION_END,
} from '../../../src/installer/instructions-template';

/** A literal list of phrases the block must not contain, matched against the normalised (lower-case) text. It guards these phrases, not the rule: a reworded instruction to skip CodeGraph would pass. */
const FORBIDDEN_PHRASES = ['skip codegraph', "user's decision"];

/** Lower-cases the text and folds curly apostrophes (U+2018, U+2019) to ASCII, so those spellings of the listed phrases are still caught; other rewordings are not. */
function normaliseForScan(text: string): string {
  return text.toLowerCase().replace(/[\u2018\u2019]/g, "'");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('CodeGraph instructions block (gate)', () => {
  it('contains none of the forbidden phrases', () => {
    const normalised = normaliseForScan(CODEGRAPH_INSTRUCTIONS_BLOCK);
    const offending = FORBIDDEN_PHRASES.filter((phrase) => normalised.includes(phrase));
    // One assertion over the list, so a failure names every forbidden phrase it found.
    expect(offending, 'forbidden phrases found in the instructions block').toEqual([]);
  });

  it('still names the MCP tool and the CLI command', () => {
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('`codegraph_explore`');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('codegraph explore');
  });

  it('is one marker-fenced section: start marker first, end marker last, each marker once', () => {
    expect(
      CODEGRAPH_INSTRUCTIONS_BLOCK.startsWith(CODEGRAPH_SECTION_START),
      'block must start with the start marker',
    ).toBe(true);
    expect(
      CODEGRAPH_INSTRUCTIONS_BLOCK.endsWith(CODEGRAPH_SECTION_END),
      'block must end with the end marker',
    ).toBe(true);
    expect(countOccurrences(CODEGRAPH_INSTRUCTIONS_BLOCK, CODEGRAPH_SECTION_START), 'start marker count').toBe(1);
    expect(countOccurrences(CODEGRAPH_INSTRUCTIONS_BLOCK, CODEGRAPH_SECTION_END), 'end marker count').toBe(1);
  });
});
