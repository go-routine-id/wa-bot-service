'use strict';

const { HttpError } = require('../utils/httpError');

/**
 * Validasi input template.
 * Mengembalikan field yang sudah dibersihkan, atau melempar HttpError 400.
 */
function validateTemplateInput(body) {
  const name = String(body?.name ?? '').trim();
  const textContent = String(body?.textContent ?? '').trim();
  const mediaPath = body?.mediaPath ?? null;

  if (!name) throw new HttpError(400, 'Nama template wajib diisi');
  if (!textContent) throw new HttpError(400, 'Isi pesan template wajib diisi');
  if (mediaPath != null && typeof mediaPath !== 'string') {
    throw new HttpError(400, 'mediaPath tidak valid');
  }

  return { name, textContent, mediaPath: mediaPath || null };
}

module.exports = { validateTemplateInput };
