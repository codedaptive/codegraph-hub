/**
 * Maps a file's `#!` line to a CodeGraph language (R-49(a)), so an extensionless script such as `bin/tool`
 * can be indexed with its interpreter's grammar; the extraction hook-in calls it. Pure: it reads only the text
 * it is given.
 * Shells and perl map to nothing because CodeGraph has no grammar for them.
 */
import type { Language } from '../../../types';

/** Only this much is looked at; a NUL anywhere in it (not just line 1, e.g. a zipapp) marks the file binary. */
const HEAD_LIMIT = 256;

/** A Map, not an object literal, so names such as `toString` or `__proto__` find no inherited member. */
const INTERPRETERS = new Map<string, Language>([
  ['python', 'python'],
  ['pypy', 'python'],
  ['node', 'javascript'],
  ['nodejs', 'javascript'],
  ['bun', 'javascript'],
  ['deno', 'typescript'],
  ['ts-node', 'typescript'],
  ['tsx', 'typescript'],
  ['ruby', 'ruby'],
  ['php', 'php'],
  ['lua', 'lua'],
  ['luajit', 'lua'],
  ['rscript', 'r'],
  ['swift', 'swift'],
]);

function basename(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1).toLowerCase();
}

/** The interpreter's name: the program, or for `env` the first operand after its options and assignments. */
function interpreterName(tokens: string[]): string | undefined {
  const program = tokens[0] === undefined ? undefined : basename(tokens[0]);
  if (program !== 'env') return program;
  const operand = tokens.slice(1).find((token) => !token.startsWith('-') && !token.includes('='));
  return operand === undefined ? undefined : basename(operand);
}

/** The language named by the `#!` line at the start of `head`, or null when there is none CodeGraph parses. */
export function shebangLanguage(head: string): Language | null {
  const window = head.slice(0, HEAD_LIMIT);
  if (window.includes('\0') || !window.startsWith('#!')) return null;
  const newline = window.indexOf('\n');
  const line = (newline === -1 ? window : window.slice(0, newline)).replace(/\r$/, '');
  const tokens = line.slice(2).split(/[ \t]+/).filter((token) => token !== '');
  const name = interpreterName(tokens)?.replace(/[\d.]+$/, '');
  return name === undefined ? null : (INTERPRETERS.get(name) ?? null);
}
