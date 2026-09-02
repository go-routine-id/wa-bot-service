'use strict';

const crypto = require('crypto');

/**
 * Verifikasi JWT RS256 memakai crypto bawaan Node — tanpa dependency baru.
 *
 * account-service menerbitkan token RS256 dan mengekspos kunci publiknya di
 * `GET /api/v1/auth/public-key` (PEM apa adanya, bukan JWKS). Yang kita lakukan
 * di sini murni verifikasi tanda tangan + klaim; pengambilan & cache kunci ada
 * di services/accountService.js.
 */

class JwtError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'JwtError';
    // reason dipakai pemanggil untuk membedakan "token kedaluwarsa" (klien perlu
    // refresh) dari "token cacat" (jangan refresh, itu tidak akan menolong).
    this.reason = reason;
  }
}

function base64UrlDecode(input) {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function parseJson(buf, what) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    throw new JwtError(`${what} token tidak valid`, 'malformed');
  }
}

/** Baca header tanpa memverifikasi — dipakai untuk mengetahui `kid` lebih dulu. */
function decodeHeader(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new JwtError('Format token tidak valid', 'malformed');
  return parseJson(base64UrlDecode(parts[0]), 'Header');
}

/**
 * @param {string} token
 * @param {string} publicKeyPem  PEM dari account-service
 * @param {object} opts
 *   issuer            — wajib cocok dengan klaim `iss`
 *   audience          — bila diisi, `aud` wajib memuatnya
 *   clockToleranceSec — toleransi selisih jam antar mesin
 * @returns {object} payload terverifikasi
 */
function verifyRS256(token, publicKeyPem, { issuer, audience, clockToleranceSec = 30 } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new JwtError('Format token tidak valid', 'malformed');
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = parseJson(base64UrlDecode(headerB64), 'Header');

  // Algoritma dikunci ke RS256 dan diperiksa SEBELUM apa pun.
  //
  // Ini pertahanan terhadap algorithm confusion: penyerang mengganti alg jadi
  // "none" (tanpa tanda tangan) atau "HS256" (tanda tangan HMAC memakai kunci
  // PUBLIK kita sebagai rahasia — dan kunci publik memang bisa siapa saja
  // dapatkan). Mempercayai alg dari header adalah kerentanan JWT yang klasik.
  if (header.alg !== 'RS256') {
    throw new JwtError(`Algoritma token tidak didukung: ${header.alg}`, 'bad_alg');
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'ascii');
  const signature = base64UrlDecode(signatureB64);

  let valid;
  try {
    valid = crypto.verify('RSA-SHA256', signingInput, publicKeyPem, signature);
  } catch (err) {
    // Kunci publik cacat / bukan RSA — masalah konfigurasi, bukan token.
    throw new JwtError(`Kunci publik tidak bisa dipakai: ${err.message}`, 'bad_key');
  }
  if (!valid) throw new JwtError('Tanda tangan token tidak sah', 'bad_signature');

  const payload = parseJson(base64UrlDecode(payloadB64), 'Payload');
  const now = Math.floor(Date.now() / 1000);

  // `exp` WAJIB ada. Bentuk sebelumnya hanya memeriksa bila klaimnya kebetulan
  // ada, sehingga token tanpa `exp` berlaku selamanya. Seluruh jalur terbitan
  // account-service (login, token-exchange, system-token) selalu mengisinya,
  // jadi mewajibkannya tidak memutus siapa pun.
  if (typeof payload.exp !== 'number') {
    throw new JwtError('Token tanpa masa berlaku (exp)', 'malformed');
  }
  if (now > payload.exp + clockToleranceSec) {
    throw new JwtError('Token kedaluwarsa', 'expired');
  }
  if (typeof payload.nbf === 'number' && now + clockToleranceSec < payload.nbf) {
    throw new JwtError('Token belum berlaku', 'not_yet_valid');
  }
  if (issuer && payload.iss !== issuer) {
    throw new JwtError('Penerbit token tidak dikenal', 'bad_issuer');
  }
  if (audience) {
    // `aud` boleh string atau array; account-service menghilangkannya bila kosong.
    const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    if (!aud.includes(audience)) {
      throw new JwtError('Audience token tidak cocok', 'bad_audience');
    }
  }

  return payload;
}

module.exports = { verifyRS256, decodeHeader, JwtError };
