'use strict';

const { Router } = require('express');
const sessionController = require('../controllers/sessionController');

const router = Router();

/**
 * @openapi
 * /api/sessions:
 *   get:
 *     tags: [Sesi WhatsApp]
 *     summary: Daftar sesi milik organisasi
 *     description: Satu sesi = satu nomor WhatsApp ter-pair. Sesi organisasi lain tidak muncul.
 *     responses:
 *       200: { description: Daftar sesi beserta status runtime-nya }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/', sessionController.list);
/**
 * @openapi
 * /api/sessions:
 *   post:
 *     tags: [Sesi WhatsApp]
 *     summary: Tambah sesi baru
 *     description: |
 *       Membuat sesi lalu langsung memulai proses pairing — QR akan muncul di
 *       `GET /api/sessions/{id}/status`. Id sesi adalah slug dari nama.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, example: Promo Ramadan }
 *     responses:
 *       201: { description: Sesi dibuat, status awal connecting }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/', sessionController.add);
/**
 * @openapi
 * /api/sessions/{id}/status:
 *   get:
 *     tags: [Sesi WhatsApp]
 *     summary: Status runtime satu sesi
 *     description: |
 *       Memuat status koneksi, QR (bila sedang pairing) beserta waktu
 *       kedaluwarsanya, dan identitas nomor yang terhubung. QR berlaku singkat;
 *       setelah lewat, statusnya menjadi `qr_expired` dan QR harus diminta ulang
 *       lewat `/rescan` — sengaja manual agar tidak terjadi pairing berulang.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string }, description: Slug sesi }
 *     responses:
 *       200: { description: Status sesi }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:id/status', sessionController.status);
/**
 * @openapi
 * /api/sessions/{id}:
 *   patch:
 *     tags: [Sesi WhatsApp]
 *     summary: Ganti nama sesi
 *     description: Hanya labelnya yang berubah; id sesi tetap, jadi broadcast lama tidak terputus.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *     responses:
 *       200: { description: Sesi diperbarui }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.patch('/:id', sessionController.rename);
/**
 * @openapi
 * /api/sessions/{id}:
 *   delete:
 *     tags: [Sesi WhatsApp]
 *     summary: Hapus sesi
 *     description: |
 *       Broadcast yang masih memakai sesi ini dibatalkan lebih dulu, dan
 *       penerimanya ditandai `skipped` — bukan dibiarkan menggantung. Kredensial
 *       WhatsApp-nya ikut dihapus dari disk.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Sesi dihapus }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.delete('/:id', sessionController.remove);
/**
 * @openapi
 * /api/sessions/{id}/rescan:
 *   post:
 *     tags: [Sesi WhatsApp]
 *     summary: Minta QR baru
 *     description: Dipakai setelah QR kedaluwarsa atau saat ingin memindahkan sesi ke nomor lain.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Pairing dimulai ulang }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.post('/:id/rescan', sessionController.rescan);
/**
 * @openapi
 * /api/sessions/{id}/pairing-code:
 *   post:
 *     tags: [Sesi WhatsApp]
 *     summary: Kode pairing sebagai ganti QR
 *     description: Alternatif memindai QR — WhatsApp memasukkan kode ini di perangkat tertaut.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phoneNumber]
 *             properties:
 *               phoneNumber: { type: string, example: '6281234567890' }
 *     responses:
 *       200: { description: Kode pairing }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.post('/:id/pairing-code', sessionController.pairingCode);
/**
 * @openapi
 * /api/sessions/{id}/logout:
 *   post:
 *     tags: [Sesi WhatsApp]
 *     summary: Keluarkan sesi dari WhatsApp
 *     description: |
 *       Berbeda dari hapus: baris sesinya tetap ada sehingga bisa dipakai ulang
 *       dengan memindai QR lagi. Hanya kredensial WhatsApp-nya yang dilepas.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Sesi keluar dari WhatsApp }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.post('/:id/logout', sessionController.logout);

module.exports = router;
