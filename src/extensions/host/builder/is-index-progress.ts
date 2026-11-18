/**
 * Whether a job's progress payload is the engine's IndexProgress, as ./index-root-body.ts and ./sync-root-body.ts
 * send it: a known phase and numeric `current` and `total`. A `{log: line}` payload (./progress-log-line.ts) is not.
 */
import type { IndexProgress } from '../../../extraction';

const PHASES: ReadonlySet<unknown> = new Set<IndexProgress['phase']>(['scanning', 'parsing', 'storing', 'resolving', 'linking']);

export function isIndexProgress(payload: unknown): payload is IndexProgress {
  return typeof payload === 'object' && payload !== null
    && 'phase' in payload && PHASES.has(payload.phase)
    && 'current' in payload && typeof payload.current === 'number'
    && 'total' in payload && typeof payload.total === 'number';
}
