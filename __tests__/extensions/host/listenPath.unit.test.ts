import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listenPath } from '../../helpers/listenPath';

// The POSIX cases expect '/'-joined paths, which only a POSIX host's path.join gives.
const POSIX_HOST = process.platform !== 'win32';

describe('listenPath', () => {
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    originalPlatform = process.platform;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it.runIf(POSIX_HOST)('returns a socket path in the directory on non-Windows platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(listenPath('/tmp/cg-psp-abc123', 's')).toBe('/tmp/cg-psp-abc123/s.sock');
  });

  it('returns a named pipe using the directory basename on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(listenPath('/tmp/cg-psp-abc123', 's')).toBe('\\\\.\\pipe\\cg-psp-abc123-s');
  });

  it.runIf(POSIX_HOST)('reads the platform for each call', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(listenPath('/tmp/cg-psp-abc123', 's')).toBe('/tmp/cg-psp-abc123/s.sock');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(listenPath('/tmp/cg-psp-abc123', 's')).toBe('\\\\.\\pipe\\cg-psp-abc123-s');
  });
});
