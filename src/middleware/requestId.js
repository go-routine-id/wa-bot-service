'use strict';

const crypto = require('node:crypto');

/**
 * Satu id per request, untuk menelusuri sebuah error dari layar pengguna sampai
 * ke baris log.
 *
 * Header yang masuk DIHORMATI: kalau pemanggil (atau service lain) sudah
 * membawa X-Request-ID, id itu dipakai apa adanya sehingga satu alur lintas
 * service punya id yang sama. Kalau tidak ada, dibuatkan baru.
 *
 * Nama header & bentuk field disamakan dengan go-contact (`X-Request-ID` di
 * header, `request_id` di body) supaya kedua service kita bisa ditelusuri
 * dengan cara yang persis sama.
 */
const HEADER = 'X-Request-ID';

// Batasi id dari luar: ia ikut tercetak di log dan dikirim balik ke klien, jadi
// jangan menerima teks panjang/aneh yang bisa mengotori atau memalsukan baris log.
const POLA_AMAN = /^[A-Za-z0-9._:-]{1,128}$/;

function requestId(req, res, next) {
  const dari = String(req.get(HEADER) || '').trim();
  const id = POLA_AMAN.test(dari) ? dari : crypto.randomUUID();
  req.requestId = id;
  res.setHeader(HEADER, id);
  next();
}

module.exports = { requestId, REQUEST_ID_HEADER: HEADER };
