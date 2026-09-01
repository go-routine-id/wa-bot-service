'use strict';

const { HttpError } = require('../utils/httpError');
const mediaService = require('../services/mediaService');
const templateRepository = require('../repositories/templateRepository');

const mediaController = {
  upload(req, res) {
    if (!req.file) throw new HttpError(400, 'File gambar wajib di-upload');
    const data = mediaService.saveUploaded(req.file);
    res.status(201).json({ data });
  },

  remove(req, res) {
    const mediaPath = req.body?.mediaPath;
    if (!mediaPath || typeof mediaPath !== 'string') {
      throw new HttpError(400, 'mediaPath wajib diisi');
    }
    if (!mediaPath.startsWith('templates/')) {
      throw new HttpError(400, 'Hanya media template yang bisa dihapus lewat endpoint ini');
    }
    // Endpoint ini dipakai frontend untuk MEMBATALKAN upload yang belum tersimpan.
    // Kalau file ternyata sudah direferensikan sebuah template, menghapusnya akan
    // membuat gambar template rusak — tolak, sejalan dengan cleanupMediaIfUnused
    // di templateController.
    if (templateRepository.findByMediaPathUnscoped(mediaPath)) {
      throw new HttpError(409, 'Media masih dipakai template — hapus/ubah templatenya dulu');
    }
    mediaService.delete(mediaPath);
    res.json({ ok: true });
  },
};

module.exports = mediaController;
