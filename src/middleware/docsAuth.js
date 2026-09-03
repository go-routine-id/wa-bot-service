'use strict';

const crypto = require('node:crypto');

/**
 * Basic auth untuk halaman dokumentasi.
 *
 * Dibanding dengan crypto.timingSafeEqual, bukan `===`: perbandingan string
 * biasa berhenti di karakter pertama yang berbeda, sehingga lama eksekusinya
 * membocorkan berapa banyak karakter awal yang sudah benar. Penjagaan kecil,
 * tapi tidak ada alasan untuk tidak melakukannya.
 */
function samaAman(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // Panjang berbeda tetap dibandingkan agar waktunya seragam; hasilnya
  // dipastikan salah lewat pengecekan panjang.
  const panjangSama = ba.length === bb.length;
  const pembanding = panjangSama ? bb : ba;
  return crypto.timingSafeEqual(ba, pembanding) && panjangSama;
}

function basicAuth(user, pass, realm = 'Dokumentasi API') {
  return (req, res, next) => {
    const header = req.get('Authorization') || '';
    if (header.startsWith('Basic ')) {
      const [u, ...sisa] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
      if (samaAman(u, user) && samaAman(sisa.join(':'), pass)) return next();
    }
    res.setHeader('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
    res.status(401).json({ error: 'Butuh kredensial dokumentasi', request_id: req.requestId || null });
  };
}

module.exports = { basicAuth };
