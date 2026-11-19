import { describe, expect, it } from 'vitest';
import { unprovenReleaseRefusal } from '../../../src/extensions/host/unprovenReleaseRefusal';

describe('unproven release refusal', () => {
  it.each([
    [
      '`codegraph index`',
      'The process on /example/state/server.sock did not confirm that it released /example/project, so it may still hold the database open. Run `codegraph daemon --stop`, then retry `codegraph index`. The stop acts only on the process the server lock (server.pid) names, and only when the server on the lock\'s socket proves it runs as this user. If the stop does not report that it stopped the server, or `codegraph index` refuses again, find the process listening on /example/state/server.sock, check it is nothing you need, stop it, then retry `codegraph index`.',
    ],
    [
      '`codegraph uninit`',
      'The process on /example/state/server.sock did not confirm that it released /example/project, so it may still hold the database open. Run `codegraph daemon --stop`, then retry `codegraph uninit`. The stop acts only on the process the server lock (server.pid) names, and only when the server on the lock\'s socket proves it runs as this user. If the stop does not report that it stopped the server, or `codegraph uninit` refuses again, find the process listening on /example/state/server.sock, check it is nothing you need, stop it, then retry `codegraph uninit`.',
    ],
    [
      '`codegraph init`',
      'The process on /example/state/server.sock did not confirm that it released /example/project, so it may still hold the database open. Run `codegraph daemon --stop`, then retry `codegraph init`. The stop acts only on the process the server lock (server.pid) names, and only when the server on the lock\'s socket proves it runs as this user. If the stop does not report that it stopped the server, or `codegraph init` refuses again, find the process listening on /example/state/server.sock, check it is nothing you need, stop it, then retry `codegraph init`.',
    ],
  ])('gives the exact recovery advice for %s', (retry, expected) => {
    expect(unprovenReleaseRefusal('/example/project', '/example/state/server.sock', retry)).toBe(expected);
  });
});
