'use strict';

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.statusCode || 500;
  if (status >= 500) {
    // Pesan 4xx (HttpError) memang ditulis untuk dibaca user. Pesan 500 datang
    // dari error tak terduga — bisa memuat jalur file, nama tabel, atau detail
    // SQLite yang tak perlu dibocorkan ke klien. Catat lengkap di log, balas umum.
    console.error('[server] error:', err);
    return res.status(status).json({ error: 'Terjadi kesalahan pada server' });
  }
  res.status(status).json({ error: err.message || 'Terjadi kesalahan' });
}

module.exports = { errorHandler };
