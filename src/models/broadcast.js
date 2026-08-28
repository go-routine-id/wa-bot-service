'use strict';

const { HttpError } = require('../utils/httpError');
const config = require('../../config');

const BROADCAST_MODES = ['queue', 'parallel'];
const BROADCAST_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'];
const RECIPIENT_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'];

/**
 * Validasi input create broadcast.
 * body: { mode, ratePerMinute, recipients, templateId?, messageText?, mediaPath? }
 * Mengembalikan object yang sudah dinormalisasi, atau melempar HttpError 400.
 */
function validateBroadcastCreate(body) {
  const mode = body?.mode;
  if (!BROADCAST_MODES.includes(mode)) {
    throw new HttpError(400, 'mode wajib "queue" atau "parallel"');
  }

  const ratePerMinute = Number.parseInt(body?.ratePerMinute ?? config.defaultRatePerMinute, 10);
  if (!Number.isInteger(ratePerMinute) || ratePerMinute < 1 || ratePerMinute > config.maxRatePerMinute) {
    throw new HttpError(
      400,
      `ratePerMinute harus angka 1–${config.maxRatePerMinute}`
    );
  }

  const recipients = String(body?.recipients ?? '').trim();
  if (!recipients) throw new HttpError(400, 'Daftar nomor tujuan wajib diisi');

  const templateId = body?.templateId ? Number.parseInt(body.templateId, 10) : null;
  const hasTemplate = Number.isInteger(templateId) && templateId > 0;
  const messageText = body?.messageText != null ? String(body.messageText).trim() : '';
  const mediaPath = body?.mediaPath ?? null;

  if (hasTemplate && messageText) {
    throw new HttpError(400, 'Pilih salah satu: pakai template ATAU tulis pesan langsung');
  }
  if (!hasTemplate && !messageText) {
    throw new HttpError(400, 'Isi pesan langsung atau pilih template');
  }
  if (!hasTemplate && mediaPath != null && typeof mediaPath !== 'string') {
    throw new HttpError(400, 'mediaPath tidak valid');
  }

  return {
    mode,
    ratePerMinute,
    recipients,
    templateId: hasTemplate ? templateId : null,
    messageText: hasTemplate ? null : messageText,
    mediaPath: hasTemplate ? null : mediaPath || null,
  };
}

module.exports = {
  BROADCAST_MODES,
  BROADCAST_STATUSES,
  RECIPIENT_STATUSES,
  validateBroadcastCreate,
};
