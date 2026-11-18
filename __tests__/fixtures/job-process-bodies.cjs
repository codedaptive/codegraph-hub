exports.progress = async (args, ctx) => {
  ctx.progress('first');
  ctx.progress('second');
  return { answer: 42 };
};
exports.fail = async () => { throw new Error('fixture failed'); };
exports.exit = () => { process.exit(17); };
exports.hold = async (args, ctx) => {
  ctx.progress('ready');
  await new Promise(() => {});
};
exports.database = async (args, ctx) => {
  ctx.reportDatabase('/root', 'device:inode');
  ctx.progress('ready');
  await new Promise(() => {});
};
exports.databaseResult = async (args, ctx) => {
  ctx.reportDatabase('/root', 'device:inode');
  return { answer: 42 };
};
exports.memory = async (args, ctx) => {
  const memory = Buffer.alloc(200 * 1024 * 1024, 1);
  ctx.progress(memory.length);
  await new Promise(() => {});
};
