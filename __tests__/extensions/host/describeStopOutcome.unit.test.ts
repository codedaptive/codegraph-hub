import { describe, expect, it } from 'vitest';
import { describeStopOutcome } from '../../../src/extensions/host/server/describeStopOutcome';

const pid = 4321;
const version = '1.6.2-sm.12';
const socketPath = '/example/state/server.sock';

describe('describeStopOutcome', () => {
  it('reports a stop as success', () => {
    expect(describeStopOutcome({ outcome: 'stopped', pid, version }, 'darwin')).toEqual({
      level: 'success', exitCode: 0, text: 'Stopped the CodeGraph server (pid 4321, v1.6.2-sm.12).',
    });
  });

  it('reports no server as info with exit 0', () => {
    expect(describeStopOutcome({ outcome: 'not-running' }, 'darwin')).toEqual({
      level: 'info', exitCode: 0, text: 'No CodeGraph server running.',
    });
  });

  it('reports a busy server as an error', () => {
    expect(describeStopOutcome({ outcome: 'busy', pid, version }, 'darwin')).toEqual({
      level: 'error', exitCode: 1,
      text: 'The CodeGraph server is running but busy (pid 4321, v1.6.2-sm.12): it accepted the connection and ' +
        'sent no hello within 1 s, so it was left running. Retry `codegraph daemon --stop` in a moment, or wait ' +
        'for it to finish.',
    });
  });

  it('reports an unverified lock holder as an error', () => {
    expect(describeStopOutcome({ outcome: 'unverified', pid, version }, 'darwin')).toEqual({
      level: 'error', exitCode: 1,
      text: 'Process 4321 holds the server lock but did not answer as the CodeGraph server, so it was left ' +
        'running. If it is not a CodeGraph server, delete the stale server.pid in the state dir. That does not ' +
        'stop a process listening on the server socket; if `codegraph index`, `uninit` or `init` still refuses, ' +
        'it names that socket.',
    });
  });

  it('reports an unproven server as an error naming its socket', () => {
    expect(describeStopOutcome({ outcome: 'unproven', pid, version, socketPath }, 'darwin')).toEqual({
      level: 'error', exitCode: 1,
      text: 'The process on /example/state/server.sock answered as the CodeGraph server (pid 4321, v1.6.2-sm.12) ' +
        'but did not prove it runs as this user, so nothing was signalled. Check whether pid 4321 is the process ' +
        'listening on /example/state/server.sock; if it is, and it is a CodeGraph server you started, stop it ' +
        'by hand.',
    });
  });

  it.each(['darwin', 'linux', 'win32'] as const)('gives no kill command for an unproven server on %s', platform => {
    const { text } = describeStopOutcome({ outcome: 'unproven', pid, version, socketPath }, platform);
    expect(text).toContain('/example/state/server.sock');
    expect(text).toContain('pid 4321');
    expect(text).not.toContain('kill');
    expect(text).not.toContain('taskkill');
  });

  it('reports a kept server as an error', () => {
    expect(describeStopOutcome({ outcome: 'kept', pid, version }, 'darwin')).toEqual({
      level: 'error', exitCode: 1, text: 'Left the CodeGraph server (pid 4321, v1.6.2-sm.12) running.',
    });
  });

  it.each(['darwin', 'linux'] as const)('tells %s to kill -9 a server still running after SIGTERM', platform => {
    expect(describeStopOutcome({ outcome: 'still-running', pid, version }, platform)).toEqual({
      level: 'error', exitCode: 1,
      text: 'The CodeGraph server (pid 4321, v1.6.2-sm.12) proved itself on its socket but did not exit after ' +
        'SIGTERM. Stop it with `kill -9 4321`; that skips its graceful shutdown.',
    });
  });

  it('tells Windows to taskkill a server still running after SIGTERM', () => {
    expect(describeStopOutcome({ outcome: 'still-running', pid, version }, 'win32')).toEqual({
      level: 'error', exitCode: 1,
      text: 'The CodeGraph server (pid 4321, v1.6.2-sm.12) proved itself on its socket but did not exit after ' +
        'SIGTERM. Stop it with `taskkill /PID 4321 /F`; that skips its graceful shutdown.',
    });
  });
});
