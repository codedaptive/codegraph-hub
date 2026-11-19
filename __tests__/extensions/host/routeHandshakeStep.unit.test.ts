import { beforeEach, describe, expect, it, vi } from 'vitest';
import { daemonAnswerProves } from '../../../src/mcp/daemonAnswerProves';
import { routeHandshakeStep } from '../../../src/extensions/host/builder/routeHandshakeStep';

vi.mock('../../../src/mcp/daemonAnswerProves', () => ({ daemonAnswerProves: vi.fn() }));
vi.mock('../../../src/mcp/server-control', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/mcp/server-control')>(),
  controlClientHelloLine: () => '{"codegraph_client":1,"control":1,"pid":1234,"hostPid":null}\n',
}));

const lock = { pid: 1234, version: '1.2.3', socketPath: '/socket/server', startedAt: 1, stateDir: '/state', stateId: 'state' };
const hello = { protocol: 1, codegraph: '1.2.3', pid: 1234 };
const challenge = 'handshake-challenge';

beforeEach(() => vi.resetAllMocks());

describe('routeHandshakeStep', () => {
  it('challenges a hello matching the lock', () => {
    expect(routeHandshakeStep('hello', hello, lock, challenge)).toEqual({
      next: 'proof', write: '{"codegraph_challenge":"handshake-challenge"}\n',
    });
  });

  it.each([
    ['pid mismatch', { ...hello, pid: 1235 }],
    ['version mismatch', { ...hello, codegraph: 'other' }],
    ['not a server hello', { ...hello, protocol: 2 }],
    ['null', null],
    ['array', []],
    ['number', 5],
  ])('rejects hello with %s', (_name, message) => {
    expect(routeHandshakeStep('hello', message, lock, challenge)).toBeNull();
  });

  it('opens and writes the control hello on a valid proof', () => {
    vi.mocked(daemonAnswerProves).mockReturnValue(true);
    expect(routeHandshakeStep('proof', { codegraph_proof: 'proof' }, lock, challenge)).toEqual({
      next: 'open', write: '{"codegraph_client":1,"control":1,"pid":1234,"hostPid":null}\n',
    });
    expect(daemonAnswerProves).toHaveBeenCalledWith('handshake-challenge', '/socket/server', 'proof');
  });

  it('rejects an invalid proof', () => {
    vi.mocked(daemonAnswerProves).mockReturnValue(false);
    expect(routeHandshakeStep('proof', { codegraph_proof: 'bad' }, lock, challenge)).toBeNull();
  });

  it.each([null, [], 5])('rejects non-object proof %j without checking it', message => {
    expect(routeHandshakeStep('proof', message, lock, challenge)).toBeNull();
    expect(daemonAnswerProves).not.toHaveBeenCalled();
  });
});
