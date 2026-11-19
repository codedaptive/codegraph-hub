import { describe, expect, it } from 'vitest';
import { unprovenReleaseRefusal } from '../../../src/extensions/host/unprovenReleaseRefusal';

describe('unproven release refusal', () => {
  it.each(['`codegraph index`', '`codegraph uninit`'])(
    'identifies the root and socket and gives recovery advice for %s', (retry) => {
      const message = unprovenReleaseRefusal('/example/project', '/example/state/server.sock', retry);
      expect(message).toContain('did not confirm that it released /example/project');
      expect(message).toContain('on /example/state/server.sock');
      expect(message).toContain('find the process listening on /example/state/server.sock');
      expect(message.split('/example/state/server.sock').length - 1).toBeGreaterThanOrEqual(2);
      expect(message).toContain('`codegraph daemon --stop`');
      expect(message).toContain(retry);
      expect(message).toContain('server.pid');
    },
  );

  it.each(['`codegraph index`', '`codegraph uninit`'])(
    'gives stop-outcome advice without conflating outcomes for %s', (retry) => {
      const message = unprovenReleaseRefusal('/example/project', '/example/state/server.sock', retry);
      expect(message).toContain('If the stop reports the server busy, retry the stop in a moment');
      expect(message).toContain('if it reports the server did not exit, stop that pid as it says');
      expect(message).toContain('If it reports no server running, or a process that holds the server lock but did not answer as the server');
      expect(message).toContain('is not this state dir\'s server');
    },
  );

  it.each(['`codegraph index`', '`codegraph uninit`'])(
    'does not infer a squatter just because the refusal comes back for %s', (retry) => {
      const message = unprovenReleaseRefusal('/example/project', '/example/state/server.sock', retry);
      expect(message).not.toContain('comes back');
    },
  );

  it.each(['`codegraph index`', '`codegraph uninit`'])(
    'separates busy and still-running advice from the squatter conclusion for %s', (retry) => {
      const message = unprovenReleaseRefusal('/example/project', '/example/state/server.sock', retry);
      const busy = message.indexOf('If the stop reports the server busy, retry the stop in a moment');
      const stillRunning = message.indexOf('if it reports the server did not exit, stop that pid as it says');
      const noServer = message.indexOf('no server running');
      const conclusion = message.indexOf('is not this state dir\'s server');
      expect(busy).toBeGreaterThanOrEqual(0);
      expect(stillRunning).toBeGreaterThan(busy);
      expect(noServer).toBeGreaterThan(stillRunning);
      expect(conclusion).toBeGreaterThan(noServer);
      expect(message.slice(stillRunning, noServer)).toContain('.');
      expect(message.slice(noServer, conclusion)).not.toContain('busy');
      expect(message.slice(noServer, conclusion)).not.toContain('did not exit');
    },
  );
});
