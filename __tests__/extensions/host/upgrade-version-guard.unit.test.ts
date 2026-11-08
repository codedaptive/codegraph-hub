import { describe, expect, it } from 'vitest';
import { isWholeVersion, upgradeTargetRefusal } from '../../../src/extensions/host/upgrade/version-guard';

const accepted = ['1.6.2', 'v1.6.2', 'v1.6.2-sm.14', '1.2.3-rc.1', '10.20.30'];
const rejected = [
  '1.2.3&calc', '1.2.3"', 'v1.2.3 | x', 'v1.2.3-sm.1&calc',
  '1.2.3\n', '1.2.3\ncalc', '1.2.3%PATH%', '1.2.3^&x',
  '1.2.3 ', ' 1.2.3', '1.2', 'latest', '', 'vv1.2.3', '1.2.3+build',
  '01.2.3', '1.02.3', '1.2.03',
];

describe('whole upgrade version guard', () => {
  it.each(accepted)('accepts whole version %j', (version) => {
    expect(isWholeVersion(version)).toBe(true);
    expect(upgradeTargetRefusal(version)).toBeNull();
  });

  it.each(rejected)('refuses non-version %j with a quoted diagnostic', (version) => {
    expect(isWholeVersion(version)).toBe(false);
    const refusal = upgradeTargetRefusal(version);
    expect(refusal).toEqual(expect.any(String));
    expect(refusal).toContain(JSON.stringify(version));
    expect(refusal).toContain('not a version');
  });
});
