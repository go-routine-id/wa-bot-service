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

  retry(req, res) {
    const data = broadcastService.retry(Number(req.params.id));
    res.status(201).json({ data });
  },
};

module.exports = broadcastController;
