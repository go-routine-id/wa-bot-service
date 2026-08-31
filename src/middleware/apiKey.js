'use strict';

const crypto = require('crypto');
const config = require('../../config');

/**
 * Proteksi API key opsional untuk /api.
 *
 * API ini bisa mengirim WhatsApp dari nomor yang terhubung, jadi siapa pun yang
 * menjangkau port-nya sebenarnya memegang kendali penuh. Selama hanya diakses
 * dari localhost itu wajar, tapi begitu port terbuka ke jaringan atau CORS
 * dilebarkan, tidak ada lagi yang menghalangi.
 *
 * Default NONAKTIF (API_KEY kosong) supaya pemakaian lokal yang sudah jalan tidak
 * ikut rusak. Set env API_KEY untuk mengaktifkan.
 */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // timingSafeEqual menuntut panjang sama; samakan lewat hash agar perbandingan
  // tetap konstan-waktu tanpa membocorkan panjang kunci.
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function apiKeyMiddleware(req, res, next) {
  if (!config.apiKey) return next(); // nonaktif — perilaku lama

  // Preflight tidak membawa header kustom; biarkan lewat (CORS yang menilainya).
  if (req.method === 'OPTIONS') return next();

  const header = req.headers['x-api-key'];
  const auth = req.headers.authorization;
  const bearer = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const given = header || bearer;

  if (given && timingSafeEqual(given, config.apiKey)) return next();

  res.status(401).json({ error: 'API key tidak valid atau belum disertakan' });
}

module.exports = { apiKeyMiddleware };
