'use strict';

const { Router } = require('express');
const mediaController = require('../controllers/mediaController');
const { uploadSingleImage } = require('../middleware/upload');

const router = Router();

/**
 * @openapi
 * /api/media:
 *   post:
 *     tags: [Media]
 *     summary: Unggah gambar
 *     description: |
 *       Hanya PNG, JPG, GIF, dan WebP. Tipe ditentukan dari ISI berkas, bukan
 *       dari nama atau header yang dikirim klien. Balasannya memuat `mediaPath`
 *       yang dipakai saat membuat template atau broadcast.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [image]
 *             properties:
 *               image: { type: string, format: binary }
 *     responses:
 *       201: { description: Berkas tersimpan, mediaPath dikembalikan }
 *       400: { $ref: '#/components/responses/BadRequest' }
 */
router.post('/', uploadSingleImage('image'), mediaController.upload);
/**
 * @openapi
 * /api/media:
 *   delete:
 *     tags: [Media]
 *     summary: Hapus gambar yang belum terpakai
 *     description: Ditolak bila gambarnya masih dipakai template atau broadcast.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [mediaPath]
 *             properties:
 *               mediaPath: { type: string }
 *     responses:
 *       200: { description: Berkas dihapus }
 *       400: { $ref: '#/components/responses/BadRequest' }
 */
router.delete('/', mediaController.remove);

module.exports = router;
