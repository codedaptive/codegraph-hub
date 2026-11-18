const fs = require('node:fs');
const path = require('node:path');
const { tryAcquireWriterLock } = require('../../../../src/mcp/writer-lock.ts');
const { statInode } = require('../../../../src/directory.ts');

function hang() {
  setInterval(() => {}, 1 << 30);
  return new Promise(() => {});
}

exports.seed = async ({ root }, ctx) => {
  const file = path.join(root, '.codegraph', `codegraph.db.seed-${process.pid}-0a1b2c3d.tmp`);
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.writeFileSync(file + suffix, 'partial seed');
  ctx.progress({ ready: true });
  return hang();
};

exports.coldBuild = async ({ root }, ctx) => {
  const result = tryAcquireWriterLock(root, 'cold-build', 'rebuild.pid');
  if (result.kind !== 'acquired') throw new Error('could not acquire rebuild lock');
  const file = path.join(root, '.codegraph', 'codegraph.db');
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.writeFileSync(file + suffix, 'partial build');
  ctx.reportDatabase(root, statInode(file));
  ctx.progress({ ready: true });
  return hang();
};
