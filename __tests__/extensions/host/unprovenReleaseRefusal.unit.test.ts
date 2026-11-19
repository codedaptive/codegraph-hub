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
      expect(message).toContain('busy');
      expect(message).toContain('no server running');
    },
  );
});
