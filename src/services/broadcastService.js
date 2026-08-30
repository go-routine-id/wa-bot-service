'use strict';

const { HttpError } = require('../utils/httpError');
const { validateBroadcastCreate, INVALID_NUMBER_ERROR } = require('../models/broadcast');
const { parseTargets } = require('../utils/phone');
const templateRepository = require('../repositories/templateRepository');
const broadcastRepository = require('../repositories/broadcastRepository');
const recipientRepository = require('../repositories/recipientRepository');
const mediaService = require('./mediaService');
const broadcastRunner = require('./broadcastRunner');
const whatsappService = require('./whatsappService');

/**
 * Inti pembuatan broadcast (dipakai create & retry):
 * insert row → copy media → insert recipient → update counts invalid → dispatch.
 * recipientItems: [{ number, status, error? }] (status 'pending'/'failed').
 */
function createCore({ templateId, sessionId, mode, ratePerMinute, delaySeconds = null, messageText, mediaPath, recipientItems }) {
  const invalidCount = recipientItems.filter((item) => item.status === 'failed').length;

  const broadcast = broadcastRepository.create({
    templateId,
    sessionId,
    mode,
    ratePerMinute,
    delaySeconds,
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

/**
 * Daftar recipient hanya boleh diubah selama broadcast BELUM diproses.
 *
 * Broadcast 'running' memakai snapshot recipient di memori runner (runBroadcast
 * mengambil findPending sekali di awal): nomor baru tidak akan terkirim, dan
 * nomor yang dihapus TETAP dikirim sementara update statusnya jadi no-op diam-diam.
 * Status final (completed/failed/cancelled) adalah catatan riwayat — untuk kirim
 * ulang pakai retry, bukan mengubah riwayat.
 */
function assertRecipientsEditable(broadcast) {
  if (broadcast.status !== 'pending') {
    throw new HttpError(
      400,
      `Daftar nomor hanya bisa diubah sebelum broadcast diproses (status sekarang: ${broadcast.status})`
    );
  }
}

const broadcastService = {
  /**
   * Buat broadcast: validasi → resolve pesan dari template/teks langsung →
   * createCore (insert/copy/recipient/dispatch).
   */
  create(body) {
    const input = validateBroadcastCreate(body);
    // Sesi pengirim wajib ADA (bukan sekadar string non-empty) — cegah broadcast
    // mengarah ke sesi yang sudah dihapus / tidak pernah ada.
    if (!whatsappService.sessionExists(input.sessionId)) {
      throw new HttpError(400, 'Sesi pengirim tidak ditemukan');
    }
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
      sessionId: input.sessionId,
      mode: input.mode,
      ratePerMinute: input.ratePerMinute,
      delaySeconds: input.delaySeconds,
      messageText,
      mediaPath,
      recipientItems,
    });
  },

  /**
   * Kirim ulang recipient yang gagal dari broadcast `id`: buat broadcast BARU
   * yang hanya berisi nomor berstatus 'failed' (nomor terkirim TIDAK pernah di-resend).
   * Mendukung override `sessionId` baru bila sesi asal sudah dihapus atau ingin dialihkan.
   * History broadcast asli tetap utuh; retry tampil sebagai entri baru yang transparan.
   */
  retry(id, { sessionId } = {}) {
    const source = broadcastRepository.findById(id);
    if (!source) throw new HttpError(404, 'Broadcast tidak ditemukan');

    // Tentukan sesi target: jika user memilih sessionId baru via body, pakai itu.
    // Jika tidak, fallback ke sessionId asal broadcast.
    const targetSessionId = (sessionId && String(sessionId).trim()) || source.sessionId;

    if (!targetSessionId) {
      throw new HttpError(
        400,
        'Pilih sesi pengirim untuk melanjutkan pengiriman ulang.'
      );
    }

    if (!whatsappService.sessionExists(targetSessionId)) {
      throw new HttpError(
        400,
        `Sesi pengirim "${targetSessionId}" tidak ditemukan — pilih sesi pengirim yang aktif.`
      );
    }

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
      sessionId: targetSessionId,
      mode: source.mode,
      ratePerMinute: source.ratePerMinute,
      delaySeconds: source.delaySeconds,
      messageText: source.messageText,
      mediaPath: source.mediaPath,
      recipientItems: failedRecipients.map((r) => ({
        number: r.recipientNumber,
        status: 'pending',
      })),
    });

    console.log(
      `[retry] #${id} → #${broadcast.id} via sesi "${targetSessionId}" (${failedRecipients.length} penerima gagal dikirim ulang)`
    );
    return broadcast;
  },

  /**
   * Tambah nomor tujuan ke broadcast yang belum diproses.
   * Nomor duplikat diabaikan (UNIQUE broadcast_id+recipient_number), nomor tak
   * valid tetap dicatat sebagai 'failed' supaya transparan seperti alur create.
   */
  addRecipients(id, rawRecipients) {
    const broadcast = broadcastRepository.findById(id);
    if (!broadcast) throw new HttpError(404, 'Broadcast tidak ditemukan');
    assertRecipientsEditable(broadcast);

    const { valid, invalid } = parseTargets(rawRecipients);
    if (valid.length + invalid.length === 0) {
      throw new HttpError(400, 'Tidak ada nomor tujuan yang valid');
    }

    const items = [
      ...valid.map((n) => ({ number: n, status: 'pending' })),
      ...invalid.map((n) => ({ number: n, status: 'failed', error: INVALID_NUMBER_ERROR })),
    ];
    const added = recipientRepository.bulkInsert(id, items);
    const skipped = items.length - added;

    broadcastRepository.recalcCounts(id);
    console.log(
      `[recipients] #${id} +${added} nomor${skipped ? ` (${skipped} duplikat diabaikan)` : ''}`
    );
    return { ...broadcastService.getDetail(id), added, skipped };
  },

  /**
   * Hapus satu nomor dari broadcast yang belum diproses.
   * Recipient 'sent' adalah bukti pesan benar-benar terkirim — menghapusnya
   * butuh konfirmasi eksplisit (confirmSent) dan dicatat di log sebagai warning.
   */
  removeRecipient(id, recipientId, { confirmSent = false } = {}) {
    const broadcast = broadcastRepository.findById(id);
    if (!broadcast) throw new HttpError(404, 'Broadcast tidak ditemukan');
    assertRecipientsEditable(broadcast);

    const recipient = recipientRepository.findById(recipientId);
    if (!recipient || recipient.broadcastId !== id) {
      throw new HttpError(404, 'Nomor tidak ditemukan di broadcast ini');
    }

    if (recipient.status === 'sent' && !confirmSent) {
      throw new HttpError(
        409,
        'Pesan ke nomor ini sudah terkirim — menghapusnya menghilangkan jejak pengiriman. Konfirmasi dulu untuk melanjutkan.'
      );
    }

    recipientRepository.remove(recipientId);
    broadcastRepository.recalcCounts(id);
    if (recipient.status === 'sent') {
      console.warn(
        `[recipients] #${id} HAPUS nomor TERKIRIM ${recipient.recipientNumber} (dikonfirmasi user)`
      );
    } else {
      console.log(
        `[recipients] #${id} hapus nomor ${recipient.recipientNumber} (${recipient.status})`
      );
    }
    return broadcastService.getDetail(id);
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
   * Batalkan SEMUA broadcast pending/running milik satu sesi (dipakai saat sesi
   * dihapus). Dipanggil sessionController SEBELUM whatsappService.deleteSession —
   * urutan ini mencegah circular dependency whatsapp → broadcast.
   */
  cancelForSession(sessionId, errorMsg = 'Sesi pengirim dihapus') {
    const running = broadcastRepository.findBySessionAndStatus(sessionId, ['pending', 'running']);
    for (const b of running) {
      broadcastRunner.setCancelled(b.id, true);
      recipientRepository.bulkUpdateStatus(b.id, ['pending', 'sending'], 'skipped', errorMsg);
      broadcastRepository.markCancelled(b.id, b.sentCount, b.failedCount);
    }
    if (running.length) {
      console.log(`[session] batalkan ${running.length} broadcast sesi "${sessionId}"`);
    }
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
