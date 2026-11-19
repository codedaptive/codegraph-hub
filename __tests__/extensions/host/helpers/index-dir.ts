import CodeGraph from '../../../../src/index';

/** Builds a complete index of `dir` and closes it. */
export async function indexDir(dir: string): Promise<void> {
  const cg = await CodeGraph.init(dir);
  try { await cg.indexAll(); } finally { cg.close(); }
}
