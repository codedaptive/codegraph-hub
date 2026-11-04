/**
 * The update check behind the MCP instructions notice and `codegraph_status` (src/upgrade/update-check.ts through
 * resolveLatestVersion in src/upgrade/index.ts) asks codedaptive/codegraph-hub for its latest release, so the notice
 * only ever names a hub release. DO_NOT_TRACK / CODEGRAPH_NO_UPDATE_CHECK still switch it off, and the hub's answer is
 * cached in its own file, so a cache upstream's lookup left behind (`update-check.json`) is never read as the hub's.
 *
 * `https` is replaced with a recorder: `get` records the URL and answers like GitHub's `/releases/latest` redirect,
 * with the hub's tag for the hub's URL and upstream's `v1.6.2` for any other, and `request` throws. The fake marks its
 * `get` with `__fake`, and a beforeAll fails the whole file before any test runs unless the `https` this file sees is
 * that fake, so a mock that stops intercepting is a failure here, never a real request.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';

const net = vi.hoisted(() => ({ gets: [] as string[], requests: 0 }));

vi.mock('https', async () => {
  const { EventEmitter } = await import('events');
  const get = (url: string, _opts: unknown, cb: (res: unknown) => void) => {
    net.gets.push(String(url));
    const res = Object.assign(new EventEmitter(), {
      statusCode: 302,
      headers: {
        location: String(url).includes('codedaptive/codegraph-hub')
          ? 'https://github.com/codedaptive/codegraph-hub/releases/tag/v1.6.2-sm.12'
          : 'https://github.com/colbymchenry/codegraph/releases/tag/v1.6.2',
      },
    });
    process.nextTick(() => {
      cb(res);
      res.emit('end');
    });
    const req = { on: () => req, setTimeout: () => req, destroy: () => undefined };
    return req;
  };
  get.__fake = true;
  const request = () => {
    net.requests += 1;
    throw new Error('https.request is not expected in this test');
  };
  return { get, request, default: { get, request } };
});
// 'https' and 'node:https' are one module to vitest: mock only 'https'; a second vi.mock for 'node:https' replaces this one.

import { resolveLatestVersion } from '../../../src/upgrade';
import {
  getUpdateNotice,
  refreshUpdateCheck,
  resetUpdateNoticeMemo,
  updateCheckCachePath,
} from '../../../src/upgrade/update-check';

const HUB_LATEST = 'https://github.com/codedaptive/codegraph-hub/releases/latest';
const T0 = 1_750_000_000_000;
const now = () => T0;

beforeAll(() => {
  if ((https.get as unknown as { __fake?: boolean }).__fake !== true) {
    throw new Error('the https fake is not in effect: refusing to run tests that would reach the network');
  }
});

let dir: string;
beforeEach(() => {
  net.gets.length = 0;
  net.requests = 0;
  resetUpdateNoticeMemo();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hub-notice-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function expectOnlyHubAsked(): void {
  expect(net.gets.length).toBeGreaterThan(0);
  for (const url of net.gets) expect(url, 'asked upstream').not.toContain('colbymchenry');
  expect(net.requests).toBe(0);
}

describe('the release lookup asks the hub', () => {
  it("resolveLatestVersion() with no arguments reads the hub's latest-release redirect", async () => {
    expect(await resolveLatestVersion()).toBe('v1.6.2-sm.12');
    expect(net.gets[0]).toBe(HUB_LATEST);
    expectOnlyHubAsked();
  });

  it("refreshUpdateCheck's default resolver names the hub release in the notice", async () => {
    const notice = await refreshUpdateCheck({ dir, env: {}, now, currentVersion: '1.6.2-sm.11' });
    expect(notice).toContain('v1.6.2-sm.12');
    expect(net.gets).toContain(HUB_LATEST);
    expectOnlyHubAsked();
  });

  for (const env of [{ DO_NOT_TRACK: '1' }, { CODEGRAPH_NO_UPDATE_CHECK: '1' }]) {
    it(`${Object.keys(env)[0]} switches the check off: no notice, no request`, async () => {
      expect(await refreshUpdateCheck({ dir, env, now, currentVersion: '1.6.2-sm.11' })).toBeNull();
      expect(getUpdateNotice({ dir, env, now, currentVersion: '1.6.2-sm.11' })).toBeNull();
      expect(net.gets).toHaveLength(0);
      expect(net.requests).toBe(0);
    });
  }
});

describe('the notice compares hub releases', () => {
  it('an sm.11 install is told about hub sm.12, and an sm.12 install is not', async () => {
    const resolveLatest = async () => 'v1.6.2-sm.12';
    const older = await refreshUpdateCheck({ dir, env: {}, now, currentVersion: '1.6.2-sm.11', resolveLatest });
    expect(older).toContain('v1.6.2-sm.12');

    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hub-notice-'));
    try {
      expect(await refreshUpdateCheck({ dir: other, env: {}, now, currentVersion: '1.6.2-sm.12', resolveLatest })).toBeNull();
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("upstream's cached answer in update-check.json is never read as the hub's", async () => {
    // A fresh cache from before the fork read the hub: upstream's v1.6.2, which outranks any 1.6.2-sm.N.
    fs.writeFileSync(
      path.join(dir, 'update-check.json'),
      JSON.stringify({ lastAttemptAt: T0, lastSuccessAt: T0, latest: 'v1.6.2' }),
    );
    const notice = getUpdateNotice({
      dir,
      env: {},
      now,
      currentVersion: '1.6.2-sm.12',
      resolveLatest: async () => 'v1.6.2-sm.12',
    });
    expect(notice ?? '').not.toMatch(/v1\.6\.2(?!-)/);
    expect(updateCheckCachePath(dir).endsWith('update-check-hub.json')).toBe(true);
    // getUpdateNotice may start a background refresh into `dir`; let it land before afterEach removes the folder.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
