'use strict';

const whatsappService = require('../services/whatsappService');
const broadcastService = require('../services/broadcastService');
const { HttpError } = require('../utils/httpError');

/** Bungkus handler async agar rejection diteruskan ke errorHandler Express. */
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const sessionController = {
  list(_req, res) {
    res.json({ data: whatsappService.listSessions() });
  },

  add(req, res) {
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Nama sesi wajib diisi');
    res.status(201).json({ data: whatsappService.addSession(name) });
  },

  rename(req, res) {
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Nama sesi wajib diisi');
    res.json({ data: whatsappService.renameSession(req.params.id, name) });
  },

  /**
   * Hapus sesi. Cancel broadcast yang memakainya DULU (via broadcastService),
   * lalu hapus row + folder + socket. Urutan ini menghindari circular
   * dependency whatsappService → broadcastService.
   */
  remove: wrap(async (req, res) => {
    broadcastService.cancelForSession(req.params.id, 'Sesi pengirim dihapus');
    await whatsappService.deleteSession(req.params.id);
    res.json({ ok: true });
  }),

  status(req, res) {
    const s = whatsappService.getStatus(req.params.id);
    if (!s) throw new HttpError(404, 'Sesi tidak ditemukan');
    res.json({ data: s });
  },

  rescan: wrap(async (req, res) => {
    await whatsappService.rescan(req.params.id);
    res.json({ ok: true });
  }),

  /** Pairing via kode 8 digit: body { phone }. Kode muncul async di status sesi. */
  pairingCode: wrap(async (req, res) => {
    const data = await whatsappService.requestPairingCode(req.params.id, req.body?.phone);
    res.json({ data });
  }),

  logout: wrap(async (req, res) => {
    await whatsappService.logoutSession(req.params.id);
    res.json({ ok: true });
  }),
};

module.exports = sessionController;
