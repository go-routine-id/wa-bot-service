'use strict';

const { HttpError } = require('../utils/httpError');
const { validateBroadcastCreate } = require('../models/broadcast');
const { parseTargets } = require('../utils/phone');
const templateRepository = require('../repositories/templateRepository');
const broadcastRepository = require('../repositories/broadcastRepository');
const recipientRepository = require('../repositories/recipientRepository');
const mediaService = require('./mediaService');
const broadcastRunner = require('./broadcastRunner');

const broadcastService = {
  /**
   * Buat broadcast: validasi → resolve pesan dari template/teks langsung →
   * insert broadcast → copy media → insert recipient → dispatch (queue/parallel).
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

    const totalRecipients = valid.length + invalid.length;

    const broadcast = broadcastRepository.create({
      templateId,
      mode: input.mode,
      ratePerMinute: input.ratePerMinute,
      messageText,
      mediaPath: null,
      totalRecipients,
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

    // Recipient: nomor valid → pending; nomor invalid → failed (transparan di history)
    const items = [
      ...valid.map((n) => ({ number: n, status: 'pending' })),
      ...invalid.map((n) => ({ number: n, status: 'failed', error: 'invalid number' })),
    ];
    recipientRepository.bulkInsert(broadcast.id, items);

    if (invalid.length > 0) {
      broadcastRepository.updateCounts(broadcast.id, 0, invalid.length);
    }

    // Dispatch sesuai mode
    if (input.mode === 'parallel') {
      broadcastRunner.spawnParallel(broadcast.id);
    } else {
      broadcastRunner.enqueue(broadcast.id);
    }

    return broadcastRepository.findById(broadcast.id);
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
