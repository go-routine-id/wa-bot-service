'use strict';

const { HttpError } = require('../utils/httpError');
const { validateTemplateInput } = require('../models/template');
const templateRepository = require('../repositories/templateRepository');
const mediaService = require('../services/mediaService');

/** Hapus file media template bila tidak dipakai template lain lagi. */
function cleanupMediaIfUnused(mediaPath) {
  if (!mediaPath) return;
  const stillUsed = templateRepository.findByMediaPath(mediaPath);
  if (!stillUsed) mediaService.delete(mediaPath);
}

const templateController = {
  list(_req, res) {
    res.json({ data: templateRepository.findAll() });
  },

  get(req, res) {
    const template = templateRepository.findById(Number(req.params.id));
    if (!template) throw new HttpError(404, 'Template tidak ditemukan');
    res.json({ data: template });
  },

  create(req, res) {
    const input = validateTemplateInput(req.body);
    const template = templateRepository.create(input);
    res.status(201).json({ data: template });
  },

  update(req, res) {
    const id = Number(req.params.id);
    const existing = templateRepository.findById(id);
    if (!existing) throw new HttpError(404, 'Template tidak ditemukan');

    const input = validateTemplateInput(req.body);
    const updated = templateRepository.update(id, input);

    // Media lama yang diganti → hapus bila tidak dipakai template lain
    if (existing.mediaPath && existing.mediaPath !== input.mediaPath) {
      cleanupMediaIfUnused(existing.mediaPath);
    }

    res.json({ data: updated });
  },

  remove(req, res) {
    const id = Number(req.params.id);
    const existing = templateRepository.findById(id);
    if (!existing) throw new HttpError(404, 'Template tidak ditemukan');

    templateRepository.remove(id);
    cleanupMediaIfUnused(existing.mediaPath);
    res.json({ ok: true });
  },
};

module.exports = templateController;
