'use strict';

const { Router } = require('express');
const broadcastController = require('../controllers/broadcastController');

const router = Router();

/**
 * @openapi
 * /api/broadcasts:
 *   post:
 *     tags: [Broadcast]
 *     summary: Buat & jalankan broadcast
 *     description: |
 *       Pesan diambil dari `templateId` ATAU `messageText` — pilih salah satu,
 *       bukan keduanya.
 *
 *       `sessionId` wajib dan harus milik organisasi pemanggil; sesi organisasi
 *       lain ditolak meski id-nya benar.
 *
 *       Kecepatan: isi `delaySeconds` (detik antar pesan) atau `ratePerMinute`.
 *       Makin rapat, makin besar risiko nomor diblokir WhatsApp.
 *
 *       Nomor berformat salah tidak membatalkan seluruh broadcast — ia tercatat
 *       sebagai penerima berstatus `failed` supaya terlihat di riwayat.
 *
 *       Sumber pembuatan dicatat otomatis: UI web (header `X-Client: web`)
 *       → `web`, jalur gRPC → `grpc`, selain itu → `api`.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId, mode, recipients]
 *             properties:
 *               sessionId:     { type: string, example: utama }
 *               mode:          { type: string, enum: [queue, parallel] }
 *               recipients:    { type: string, description: 'Dipisah koma atau baris baru', example: '6281234567890, 6289876543210' }
 *               templateId:    { type: integer, nullable: true }
 *               messageText:   { type: string, nullable: true }
 *               mediaPath:     { type: string, nullable: true }
 *               delaySeconds:  { type: number, example: 30 }
 *               ratePerMinute: { type: integer, example: 2 }
 *     responses:
 *       201: { description: Broadcast dibuat dan mulai diproses }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.post('/', broadcastController.create);
/**
 * @openapi
 * /api/broadcasts:
 *   get:
 *     tags: [Broadcast]
 *     summary: Riwayat broadcast
 *     description: |
 *       `?scope=all` membuka pandangan LINTAS ORGANISASI (read-only) —
 *       khusus akun dengan izin platform admin (`*`). Akun lain menerima 403.
 *     parameters:
 *       - { in: query, name: scope, schema: { type: string, enum: [all] }, description: 'Lintas organisasi — khusus admin platform' }
 *     responses:
 *       200: { description: Daftar broadcast beserta ringkasan penerimanya }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { description: scope=all tanpa izin admin platform }
 */
router.get('/', broadcastController.list);
/**
 * @openapi
 * /api/broadcasts/{id}:
 *   get:
 *     tags: [Broadcast]
 *     summary: Detail broadcast + status tiap penerima
 *     description: '`?scope=all` membaca broadcast lintas organisasi — khusus admin platform (izin `*`).'
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: query, name: scope, schema: { type: string, enum: [all] }, description: 'Lintas organisasi — khusus admin platform' }
 *     responses:
 *       200: { description: Detail broadcast }
 *       403: { description: scope=all tanpa izin admin platform }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:id', broadcastController.detail);
/**
 * @openapi
 * /api/broadcasts/{id}/cancel:
 *   post:
 *     tags: [Broadcast]
 *     summary: Batalkan broadcast yang sedang berjalan
 *     description: Pesan yang sudah terkirim tidak bisa ditarik; sisanya ditandai skipped.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Broadcast dibatalkan }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.post('/:id/cancel', broadcastController.cancel);
/**
 * @openapi
 * /api/broadcasts/{id}/retry:
 *   post:
 *     tags: [Broadcast]
 *     summary: Kirim ulang penerima yang gagal
 *     description: |
 *       Membuat broadcast BARU berisi hanya penerima berstatus `failed`. Nomor
 *       yang sudah terkirim tidak pernah dikirim ulang, dan riwayat aslinya utuh.
 *
 *       `sessionId` boleh diisi untuk mengalihkan ke sesi lain — sesi itu pun
 *       harus milik organisasi pemanggil.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sessionId: { type: string, nullable: true }
 *     responses:
 *       201: { description: Broadcast pengiriman ulang dibuat }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.post('/:id/retry', broadcastController.retry);
/**
 * @openapi
 * /api/broadcasts/{id}/recipients:
 *   post:
 *     tags: [Broadcast]
 *     summary: Tambah nomor tujuan
 *     description: Hanya selama broadcast belum diproses.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [recipients]
 *             properties:
 *               recipients: { type: string }
 *     responses:
 *       200: { description: Nomor ditambahkan }
 *       400: { $ref: '#/components/responses/BadRequest' }
 */
router.post('/:id/recipients', broadcastController.addRecipients);
/**
 * @openapi
 * /api/broadcasts/{id}/recipients/{recipientId}:
 *   delete:
 *     tags: [Broadcast]
 *     summary: Hapus satu nomor tujuan
 *     description: Hanya selama broadcast belum diproses.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: path, name: recipientId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Nomor dihapus }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.delete('/:id/recipients/:recipientId', broadcastController.removeRecipient);

module.exports = router;
