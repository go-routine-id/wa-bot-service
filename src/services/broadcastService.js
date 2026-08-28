'use strict';

const { HttpError } = require('../utils/httpError');
const { validateBroadcastCreate, INVALID_NUMBER_ERROR } = require('../models/broadcast');
const { parseTargets } = require('../utils/phone');
const templateRepository = require('../repositories/templateRepository');
const broadcastRepository = require('../repositories/broadcastRepository');
const recipientRepository = require('../repositories/recipientRepository');
const mediaService = require('./mediaService');
const broadcastRunner = require('./broadcastRunner');

/**
 * Inti pembuatan broadcast (dipakai create & retry):
 * insert row → copy media → insert recipient → update counts invalid → dispatch.
 * recipientItems: [{ number, status, error? }] (status 'pending'/'failed').
 */
function createCore({ templateId, mode, ratePerMinute, messageText, mediaPath, recipientItems }) {
  const invalidCount = recipientItems.filter((item) => item.status === 'failed').length;

  const broadcast = broadcastRepository.create({
    templateId,
    mode,
    ratePerMinute,
    messageText,
    mediaPath: null,
    totalRecipients: recipientItems.length,
  });

  // Copy media ke folder broadcast agar hapus template tidak merusak history
  if (mediaPath) {
    if (!mediaService.exists(mediaPath)) {
      broadcastRepository.remove(broadcast.id);
      throw new HttpError(400, 'File media tidak ditemukan');
    }
    const finalMediaPath = mediaService.copyToBroadcast(broadcast.id, mediaPath);
    broadcastRepository.setMediaPath(broadcast.id, finalMediaPath);
  }

  recipientRepository.bulkInsert(broadcast.id, recipientItems);

  if (invalidCount > 0) {
    broadcastRepository.updateCounts(broadcast.id, 0, invalidCount);
  }

  // Dispatch sesuai mode
  if (mode === 'parallel') {
    broadcastRunner.spawnParallel(broadcast.id);
  } else {
    broadcastRunner.enqueue(broadcast.id);
  }

  return broadcastRepository.findById(broadcast.id);
}

const broadcastService = {
  /**
   * Buat broadcast: validasi → resolve pesan dari template/teks langsung →
   * createCore (insert/copy/recipient/dispatch).
   */
  create(body) {
    const input = validateBroadcastCreate(body);
    const { valid, invalid } = parseTargets(input.recipients);
    if (valid.length + invalid.length === 0) {
      throw new HttpError(400, 'Tidak ada nomor tujuan yang valid');
    }

    let messageText = input.messageText;
    let mediaPath = input.mediaPath;
    let templateId = input.templateId;

    if (templateId) {
      const template = templateRepository.findById(templateId);
      if (!template) throw new HttpError(404, 'Template tidak ditemukan');
      messageText = template.textContent;
      mediaPath = template.mediaPath;
    }

    // Recipient: nomor valid → pending; nomor invalid → failed (transparan di history)
    const recipientItems = [
      ...valid.map((n) => ({ number: n, status: 'pending' })),
      ...invalid.map((n) => ({ number: n, status: 'failed', error: INVALID_NUMBER_ERROR })),
    ];

    return createCore({
      templateId,
      mode: input.mode,
      ratePerMinute: input.ratePerMinute,
      messageText,
      mediaPath,
      recipientItems,
    });
  },

  /**
   * Kirim ulang recipient yang gagal dari broadcast `id`: buat broadcast BARU
   * yang hanya berisi nomor berstatus 'failed' (nomor terkirim TIDAK pernah di-resend).
   * History broadcast asli tetap utuh; retry tampil sebagai entri baru yang transparan.
   */
  retry(id) {
    const source = broadcastRepository.findById(id);
    if (!source) throw new HttpError(404, 'Broadcast tidak ditemukan');

    // Hanya send-failure yang di-retry; nomor format-invalid ("invalid number")
    // tidak mungkin berhasil, jadi tidak ikut dibawa.
    const failedRecipients = recipientRepository
      .findByBroadcastId(id)
      .filter((r) => r.status === 'failed' && r.error !== INVALID_NUMBER_ERROR);

    if (failedRecipients.length === 0) {
      throw new HttpError(400, 'Tidak ada recipient gagal terkirim yang bisa dikirim ulang');
    }

    const broadcast = createCore({
      templateId: source.templateId,
      mode: source.mode,
      ratePerMinute: source.ratePerMinute,
      messageText: source.messageText,
      mediaPath: source.mediaPath,
      recipientItems: failedRecipients.map((r) => ({
        number: r.recipientNumber,
        status: 'pending',
      })),
    });

    console.log(
      `[retry] #${id} → #${broadcast.id} (${failedRecipients.length} penerima gagal dikirim ulang)`
    );
    return broadcast;
  },

  list({ limit, offset } = {}) {
    return broadcastRepository.list({ limit, offset });
  },

  getDetail(id) {
    const broadcast = broadcastRepository.findById(id);
    if (!broadcast) throw new HttpError(404, 'Broadcast tidak ditemukan');
    const recipients = recipientRepository.findByBroadcastId(id);
    return { broadcast, recipients };
  },

  cancel(id) {
    const broadcast = broadcastRepository.findById(id);
    if (!broadcast) throw new HttpError(404, 'Broadcast tidak ditemukan');
    if (!['pending', 'running'].includes(broadcast.status)) {
      throw new HttpError(400, `Broadcast tidak dapat dibatalkan (status: ${broadcast.status})`);
    }

    broadcastRunner.setCancelled(id, true);
    recipientRepository.bulkUpdateStatus(id, ['pending', 'sending'], 'skipped', 'Dibatalkan pengguna');
    broadcastRepository.markCancelled(id, broadcast.sentCount, broadcast.failedCount);
    return broadcastRepository.findById(id);
  },

  /**
   * Recovery saat server restart: broadcast yang 'running' → 'pending',
   * recipient 'sending' → 'pending', lalu re-dispatch (queue diambil worker,
   * parallel di-spawn ulang). Recipient 'sent' tidak di-resend.
   */
  recoverInProgress() {
    const recoverable = broadcastRepository.findRecoverable();
    if (recoverable.length === 0) return;

    for (const b of recoverable) {
      if (b.status === 'running') {
        broadcastRepository.resetToPending(b.id);
        recipientRepository.bulkUpdateStatus(b.id, ['sending'], 'pending');
      }
      if (b.mode === 'parallel') {
        broadcastRunner.spawnParallel(b.id);
      }
      // queue: diambil oleh queue worker secara FIFO
    }
    console.log(
      `[recovery] pulihkan ${recoverable.length} broadcast tertinggal: ` +
        recoverable.map((b) => `#${b.id}(${b.mode})`).join(', ')
    );
  },
};

module.exports = broadcastService;
