'use strict';

const config = require('../../config');

/**
 * Normalisasi nomor WhatsApp ke format internasional tanpa '+'.
 *
 * Dua langkah:
 *   1. Buang semua karakter non-digit — menangani '+62 853-3794-9499',
 *      '(0853) 3794 9499', dan sejenisnya.
 *   2. Awalan '0' (notasi lokal) diganti kode negara. Tanpa ini '085337949499'
 *      lolos validasi apa adanya lalu dikirim sebagai '085337949499@c.us' —
 *      WhatsApp tidak menemukannya, dan pengguna tidak pernah diberi tahu
 *      karena nomornya terlihat "valid".
 *
 * Kode negaranya dari config, bukan ditanam di sini: mengubah '0' jadi '62'
 * mengandaikan nomornya Indonesia, dan asumsi itu salah begitu ada nomor
 * Malaysia atau Singapura. Config kosong = tidak ada konversi.
 *
 * Nomor yang TIDAK diawali '0' dibiarkan apa adanya — termasuk nomor negara
 * lain yang sudah lengkap ('60123456789'). Menebak-nebak di situ lebih
 * berbahaya daripada membiarkannya.
 */
function normalizePhone(raw) {
  const digit = String(raw ?? '').replace(/\D/g, '');
  const kode = config.defaultCountryCode;
  if (!kode || !digit.startsWith('0')) return digit;
  return kode + digit.slice(1);
}

/** Panjang maksimal label entri tak valid yang disimpan (nomor asli maks 15 digit). */
const MAX_INVALID_LABEL = 32;

/** Valid: 8–15 digit (rentang panjang nomor internasional). */
function isValidPhone(number) {
  return /^\d{8,15}$/.test(number);
}

/**
 * Chat ID whatsapp-web.js untuk sebuah nomor privat: `<number>@c.us`.
 * (Group `<gid>@g.us` tidak dipakai di flow broadcast — tujuan selalu nomor HP.)
 */
function toChatId(number) {
  return `${number}@c.us`;
}

/**
 * Parse string tujuan (dipisah koma/enter/space) → array nomor ternormalisasi + valid.
 * Mengembalikan { valid: string[], invalid: string[] } (invalid = entri yang tidak jadi nomor).
 */
function parseTargets(raw) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  const parts = String(raw ?? '')
    // Dipisah HANYA oleh koma, titik koma, dan baris baru — BUKAN spasi.
    //
    // Spasi jauh lebih sering menjadi pemisah DI DALAM satu nomor
    // ('0812 3456 7890', '+62 812 3456 7890') daripada antar nomor, dan
    // memecah di situ mencabik nomor jadi potongan. Yang paling berbahaya:
    // sebagian potongan lolos validasi sebagai "nomor" — '853-3794-9499'
    // menjadi 85337949499 yang terlihat sah lalu benar-benar dikirimi pesan.
    //
    // Dua nomor yang hanya dipisah spasi kini menyatu jadi satu entri panjang
    // dan ditandai tidak valid. Itu pertukaran yang disengaja: terlihat salah
    // lebih baik daripada diam-diam mengirim ke nomor yang keliru.
    .split(/[,;\n\r]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  for (const part of parts) {
    const number = normalizePhone(part);
    if (!isValidPhone(number)) {
      // Token tanpa digit sama sekali disimpan apa adanya supaya user mengenali
      // entri mana yang salah ketik — tapi dipotong agar teks sampah panjang
      // tidak masuk utuh ke DB dan tabel history.
      // Potong SETELAH memilih nilainya: token panjang yang mengandung digit
      // menghasilkan `number` yang panjang pula, dan versi sebelumnya hanya
      // memotong cabang `part` sehingga teks sampah tetap masuk utuh ke DB.
      invalid.push((number || part).slice(0, MAX_INVALID_LABEL));
      continue;
    }
    if (seen.has(number)) continue; // dedupe
    seen.add(number);
    valid.push(number);
  }
  return { valid, invalid };
}

module.exports = { normalizePhone, isValidPhone, toChatId, parseTargets };
