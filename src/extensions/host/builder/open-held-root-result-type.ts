/**
 * What a held root's `open` job body (./open-held-root-body.ts) answers: whether the secondary indexes an
 * interrupted bulk load dropped still need rebuilding by the `recover` job (./recover-indexes-body.ts).
 */
export interface OpenHeldRootResult {
  recoveryPending: boolean;
}
