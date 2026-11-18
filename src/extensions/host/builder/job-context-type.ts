/**
 * What a job body gets beside its args (./job-child-main.ts builds it): `progress` sends one payload to the
 * builder, `reportDatabase` names a database the body created at `root` (`dev:ino`, or null where the platform
 * has none), and `writerPid` is the builder's pid, for a body that must tell the builder's locks from its own.
 */
export interface JobContext {
  progress(payload: unknown): void;
  reportDatabase(root: string, identity: string | null): void;
  writerPid: number;
}
