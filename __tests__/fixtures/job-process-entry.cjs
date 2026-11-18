process.on('message', async ({ type, spec }) => {
  if (type !== 'spec') return;
  try {
    const fn = require(spec.module)[spec.export];
    const value = await fn(spec.args, {
      progress: (payload) => process.send({ type: 'progress', payload }),
      reportDatabase: (root, identity) => process.send({ type: 'database-created', root, identity }),
      writerPid: spec.writerPid,
    });
    process.send({ type: 'result', value }, () => process.exit(0));
  } catch (error) {
    process.send({ type: 'error', message: error.message }, () => process.exit(1));
  }
});
