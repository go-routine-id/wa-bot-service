'use strict';

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.statusCode || 500;
  // Ikut dikirim ke klien DAN dicetak di log. Itu seluruh gunanya: pengguna
  // menyebut satu id, dan id itu menunjuk tepat ke satu baris log — tanpa perlu
  // menebak-nebak dari jam kejadian.
  const requestId = req.requestId || null;

  if (status >= 500) {
    // Pesan 4xx (HttpError) memang ditulis untuk dibaca user. Pesan 500 datang
    // dari error tak terduga — bisa memuat jalur file, nama tabel, atau detail
    // SQLite yang tak perlu dibocorkan ke klien. Catat lengkap di log, balas umum.
    console.error(`[server] error [${requestId}] ${req.method} ${req.originalUrl}:`, err);
    return res.status(status).json({
      error: 'Terjadi kesalahan pada server',
      request_id: requestId,
    });
  }

  // 4xx dicatat SATU BARIS, tanpa stack — ia bukan kerusakan, tapi id yang
  // dikirim ke klien harus tetap bisa ditemukan di log. Tanpa baris ini,
  // pengguna menyebut sebuah id dan kita tidak menemukan apa pun: id-nya jadi
  // janji kosong. Stack sengaja tidak dicetak supaya penolakan biasa (validasi,
  // 401, 404) tidak menenggelamkan log.
  console.warn(
    `[server] ${status} [${requestId}] ${req.method} ${req.originalUrl}: ${err.message}`
  );
  res.status(status).json({
    error: err.message || 'Terjadi kesalahan',
    request_id: requestId,
  });
}

module.exports = { errorHandler };
