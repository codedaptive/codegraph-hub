/**
 * The page counts of one SQLite database file, as its `page_size`, `page_count` and `freelist_count` pragmas
 * give them: what the builder's VACUUM rule (./freelist-over-limit.ts, ./vacuum-verdict.ts) is decided on.
 */
export interface DbPageStats {
  /** Bytes per page. */
  pageSize: number;
  /** Pages in the file, free ones included. */
  pageCount: number;
  /** Pages on the freelist: space the file holds but no table or index uses. */
  freelistCount: number;
}
