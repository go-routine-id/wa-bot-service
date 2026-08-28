'use strict';

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.statusCode || 500;
  if (status >= 500) {
    console.error('[server] error:', err);
  }
  res.status(status).json({ error: err.message || 'Terjadi kesalahan' });
}

module.exports = { errorHandler };
