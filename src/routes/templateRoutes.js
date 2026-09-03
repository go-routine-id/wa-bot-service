'use strict';

const { Router } = require('express');
const templateController = require('../controllers/templateController');

const router = Router();

/**
 * @openapi
 * /api/templates:
 *   get:
 *     tags: [Template]
 *     summary: Daftar template milik organisasi
 *     responses:
 *       200: { description: Daftar template }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/', templateController.list);
/**
 * @openapi
 * /api/templates:
 *   post:
 *     tags: [Template]
 *     summary: Buat template
 *     description: |
 *       `mediaPath` diisi dari hasil `POST /api/media`. Gambar disalin ke folder
 *       broadcast saat dipakai, jadi menghapus template tidak merusak riwayat.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, textContent]
 *             properties:
 *               name:        { type: string, example: Promo Agustus }
 *               textContent: { type: string }
 *               mediaPath:   { type: string, nullable: true }
 *     responses:
 *       201: { description: Template dibuat }
 *       400: { $ref: '#/components/responses/BadRequest' }
 */
router.post('/', templateController.create);
/**
 * @openapi
 * /api/templates/{id}:
 *   get:
 *     tags: [Template]
 *     summary: Detail template
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Template }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:id', templateController.get);
/**
 * @openapi
 * /api/templates/{id}:
 *   put:
 *     tags: [Template]
 *     summary: Ubah template
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:        { type: string }
 *               textContent: { type: string }
 *               mediaPath:   { type: string, nullable: true }
 *     responses:
 *       200: { description: Template diperbarui }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.put('/:id', templateController.update);
/**
 * @openapi
 * /api/templates/{id}:
 *   delete:
 *     tags: [Template]
 *     summary: Hapus template
 *     description: Gambarnya ikut dihapus hanya bila tidak ada broadcast lain yang memakainya.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Template dihapus }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.delete('/:id', templateController.remove);

module.exports = router;
