exports.fail = () => {
  const error = new Error('lock is unavailable');
  error.name = 'LockUnavailableError';
  throw error;
};
