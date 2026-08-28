'use strict';

const whatsappService = require('../services/whatsappService');

const connectionController = {
  getStatus(_req, res) {
    res.json({ data: whatsappService.getStatus() });
  },

  async rescan(_req, res) {
    await whatsappService.rescan();
    res.json({ ok: true });
  },

  async logout(_req, res) {
    await whatsappService.logout();
    res.json({ ok: true });
  },
};

module.exports = connectionController;
