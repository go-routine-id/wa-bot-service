'use strict';

const broadcastService = require('../services/broadcastService');

function parsePagination(query) {
  const limit = Math.min(Math.max(Number.parseInt(query?.limit ?? '50', 10) || 50, 1), 500);
  const offset = Math.max(Number.parseInt(query?.offset ?? '0', 10) || 0, 0);
  return { limit, offset };
}

const broadcastController = {
  create(req, res) {
    const data = broadcastService.create(req.body);
    res.status(201).json({ data });
  },

  list(req, res) {
    const { limit, offset } = parsePagination(req.query);
    res.json({ data: broadcastService.list({ limit, offset }) });
  },

  detail(req, res) {
    const data = broadcastService.getDetail(Number(req.params.id));
    res.json({ data });
  },

  cancel(req, res) {
    const data = broadcastService.cancel(Number(req.params.id));
    res.json({ data });
  },

  /** Tambah nomor tujuan: body { recipients }. Hanya broadcast berstatus 'pending'. */
  addRecipients(req, res) {
    const data = broadcastService.addRecipients(Number(req.params.id), req.body?.recipients);
    res.status(201).json({ data });
  },

  /**
   * Hapus satu nomor tujuan. Recipient yang sudah 'sent' ditolak 409 kecuali
   * query ?confirmSent=true (konfirmasi eksplisit user di UI).
   */
  removeRecipient(req, res) {
    const data = broadcastService.removeRecipient(
      Number(req.params.id),
      Number(req.params.recipientId),
      { confirmSent: req.query?.confirmSent === 'true' }
    );
    res.json({ data });
  },

  retry(req, res) {
    const data = broadcastService.retry(Number(req.params.id), {
      sessionId: req.body?.sessionId,
    });
    res.status(201).json({ data });
  },
};

module.exports = broadcastController;
