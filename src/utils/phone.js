'use strict';

/**
 * Normalisasi nomor WhatsApp: buang semua karakter non-digit.
 * Format hasil: digit saja (international format, tanpa '+'), mis. 6281234567890.
 */
function normalizePhone(raw) {
  return String(raw ?? '').replace(/\D/g, '');
}

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
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  for (const part of parts) {
    const number = normalizePhone(part);
    if (!isValidPhone(number)) {
      invalid.push(number || part);
      continue;
    }
    if (seen.has(number)) continue; // dedupe
    seen.add(number);
    valid.push(number);
  }
  return { valid, invalid };
}

module.exports = { normalizePhone, isValidPhone, toChatId, parseTargets };
