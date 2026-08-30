'use strict';

const { HttpError } = require('../utils/httpError');
const config = require('../../config');

const BROADCAST_MODES = ['queue', 'parallel'];
const BROADCAST_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'];
const RECIPIENT_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'];

/** Error yang ditulis ke recipient saat nomor gagal parsing (bukan kegagalan kirim). */
const INVALID_NUMBER_ERROR = 'invalid number';

/**
 * Validasi input create broadcast.
 * body: { mode, ratePerMinute?, delaySeconds?, sessionId, recipients, templateId?, messageText?, mediaPath? }
 * Mengembalikan object yang sudah dinormalisasi, atau melempar HttpError 400.
 */
function validateBroadcastCreate(body) {
  const mode = body?.mode;
  if (!BROADCAST_MODES.includes(mode)) {
    throw new HttpError(400, 'mode wajib "queue" atau "parallel"');
  }

  // Dukungan fleksibel: delaySeconds (jeda per pesan dalam detik, presisi) atau
  // ratePerMinute (pesan per menit). delaySeconds disimpan APA ADANYA (REAL) supaya
  // runner tidur tepat; ratePerMinute tetap diisi sebagai fallback + CHECK constraint
  // (kolom INTEGER 1–3600), tapi TIDAK dipakai runner bila delaySeconds ada.
  let ratePerMinute;
  let delaySeconds = null;
  if (body?.delaySeconds != null && String(body.delaySeconds).trim() !== '') {
    const delaySec = Number.parseFloat(body.delaySeconds);
    if (!Number.isFinite(delaySec) || delaySec <= 0) {
      throw new HttpError(400, 'delaySeconds harus berupa angka positif (detik per pesan)');
    }
    delaySeconds = delaySec;
    ratePerMinute = Math.max(1, Math.min(config.maxRatePerMinute, Math.round(60 / delaySec)));
  } else {
    ratePerMinute = Number.parseInt(body?.ratePerMinute ?? config.defaultRatePerMinute, 10);
  }

  if (!Number.isInteger(ratePerMinute) || ratePerMinute < 1 || ratePerMinute > config.maxRatePerMinute) {
    throw new HttpError(
      400,
      `ratePerMinute harus angka 1–${config.maxRatePerMinute}`
    );
  }

  const recipients = String(body?.recipients ?? '').trim();
  if (!recipients) throw new HttpError(400, 'Daftar nomor tujuan wajib diisi');

  // Multi-session: tiap broadcast wajib memilih satu sesi pengirim.
  const sessionId = body?.sessionId != null ? String(body.sessionId).trim() : '';
  if (!sessionId) throw new HttpError(400, 'sessionId wajib diisi (pilih sesi pengirim)');

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
    delaySeconds,
    sessionId,
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
  INVALID_NUMBER_ERROR,
  validateBroadcastCreate,
};
