/**
 * Query pool idle retirement: the env override for the idle timeout.
 *
 * `CODEGRAPH_QUERY_WORKER_IDLE_TIMEOUT_MS` sets how long a worker may sit idle
 * before the pool retires it (down to a floor of one started worker; a worker
 * still starting does not count toward the floor).
 * resolveWorkerIdleTimeoutMs parses the raw value: unset or blank gives the
 * 60 s default, a finite number >= 0 is floored, `0` means never retire, and a
 * negative or non-numeric value falls back to the default.
 */
import { describe, it, expect } from 'vitest';
import { resolveWorkerIdleTimeoutMs as resolve } from '../../../src/mcp/query-pool';

describe('resolveWorkerIdleTimeoutMs', () => {
  it('defaults to 60000 when unset or blank', () => {
    expect(resolve(undefined)).toBe(60000);
    expect(resolve('')).toBe(60000);
  });

  it('honours 0 as never retire', () => {
    expect(resolve('0')).toBe(0);
  });

  it('honours a positive integer', () => {
    expect(resolve('5000')).toBe(5000);
  });

  it('floors a fractional value', () => {
    expect(resolve('2500.7')).toBe(2500);
  });

  it('falls back to 60000 for a negative or non-numeric value', () => {
    expect(resolve('-1')).toBe(60000);
    expect(resolve('abc')).toBe(60000);
  });
});
