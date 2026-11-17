/** One builder job ended over a limit: its root as given, its kind, the limit it went over and when (ISO 8601). */
import type { JobKind } from './queue';

export interface EndedJob {
  root: string;
  kind: JobKind;
  limit: 'time' | 'rss';
  at: string;
}
