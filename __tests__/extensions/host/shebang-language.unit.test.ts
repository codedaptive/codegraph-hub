import { describe, expect, it } from 'vitest';
import { shebangLanguage } from '../../../src/extensions/host/scan/shebang-language';

describe('shebangLanguage', () => {
  it.each([
    ['#!/usr/bin/env python3', 'python'],
    ['#!/usr/bin/python3', 'python'],
    ['#!/usr/bin/env python3.12', 'python'],
    ['#!/usr/bin/python3.12 -O', 'python'],
    ['#! /usr/bin/python3', 'python'],
    ['#!/usr/bin/env pypy', 'python'],
    ['#!/usr/bin/env node', 'javascript'],
    ['#!/usr/bin/env -S node --no-warnings', 'javascript'],
    ['#!/usr/bin/env -S PYTHONPATH=x python3 -u', 'python'],
    ['#!/usr/bin/env -i -u NAME=x /usr/bin/NODEJS', 'javascript'],
    ['#!/usr/bin/bun', 'javascript'],
    ['#!/usr/bin/deno', 'typescript'],
    ['#!/usr/bin/ts-node', 'typescript'],
    ['#!/usr/bin/tsx', 'typescript'],
    ['#!/usr/bin/ruby2.7', 'ruby'],
    ['#!/usr/bin/php', 'php'],
    ['#!/usr/bin/lua', 'lua'],
    ['#!/usr/bin/luajit', 'lua'],
    ['#!/usr/bin/Rscript', 'r'],
    ['#!/usr/bin/swift', 'swift'],
    ['#!/usr/bin/python3\r\nprint(1)', 'python'],
    ['#!\t/usr/bin/env\t-S\tnode\t--flag', 'javascript'],
  ])('recognizes %s as %s', (head, language) => {
    expect(shebangLanguage(head)).toBe(language);
  });

  it.each([
    ['#!/bin/sh'], ['#!/bin/bash'], ['#!/usr/bin/env bash'],
    ['#!/bin/zsh'], ['#!/bin/dash'], ['#!/usr/bin/perl'],
    ['#!/usr/bin/env frobnicate'], ['print("hello")'],
    ['﻿#!/usr/bin/python3'], [' #!/usr/bin/python3'],
    ['#!'], ['#! \t'], ['#!/usr/bin/env -S NAME=x'],
    ['#!/usr/bin/env\npython3'],
    ['#!/usr/bin/python3\n\0binary'],
    [`#!${' '.repeat(254)}python3`],
  ])('rejects %j', (head) => {
    expect(shebangLanguage(head)).toBeNull();
  });

  it('ignores later lines and characters beyond the first 256', () => {
    expect(shebangLanguage(`#!/usr/bin/python3\n${'a'.repeat(256)}\0`)).toBe('python');
  });
});
