import { expect, it } from 'vitest';
import { valveStopLine } from '../../../src/extensions/host/builder/valve-stop-line';

it('formats the supplied next-attempt time and wait exactly', () => {
  expect(valveStopLine('/r', 'm', 5_000, new Date('2026-11-18T12:00:05.000Z')))
    .toBe('Catch-up of /r stopped by the WAL valve: m; next attempt in 5 s, at 2026-11-18T12:00:05.000Z');
  expect(valveStopLine('/other root', 'checkpoint pinned', 300_000, new Date('2026-11-18T12:05:00.000Z')))
    .toBe('Catch-up of /other root stopped by the WAL valve: checkpoint pinned; next attempt in 300 s, at 2026-11-18T12:05:00.000Z');
});
