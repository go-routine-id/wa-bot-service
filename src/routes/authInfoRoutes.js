'use strict';

const express = require('express');
const config = require('../../config');

const router = express.Router();

/**
 * Beritahu frontend KE MANA harus login. Sengaja TANPA autentikasi.
 *
 * Tanpa endpoint ini, frontend hanya tahu autentikasi menyala setelah menerima
 * 401 — dan pada titik itu ia tidak tahu alamat account-service, sehingga tidak
 * bisa menampilkan layar masuk. Akibatnya pengguna melihat dinding error tanpa
 * jalan keluar, kecuali seseorang menyetel localStorage secara manual.
 *
 * Yang dibagikan hanya yang memang publik: alamat penerbit identitas dan nama
 * izin yang dituntut. Keduanya sudah terlihat di pesan 401 dan di kode frontend,
 * jadi tidak ada rahasia yang bocor di sini.
 */
/**
 * @openapi
 * /api/auth-info:
 *   get:
 *     tags: [Autentikasi]
 *     summary: Ke mana frontend harus login
 *     description: |
 *       Satu-satunya endpoint di bawah /api yang TIDAK butuh kredensial —
 *       frontend memanggilnya sebelum punya token, untuk tahu apakah
 *       autentikasi menyala dan ke alamat account-service mana ia harus masuk.
 *     security: []
 *     responses:
 *       200:
 *         description: Konfigurasi autentikasi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:            { type: boolean }
 *                 accountServiceUrl:  { type: string }
 *                 requiredPermission: { type: string, example: 'wa-bot:*' }
 */
router.get('/auth-info', (_req, res) => {
  res.json({
    data: {
      enabled: !!config.accountServiceUrl,
      accountServiceUrl: config.accountServiceUrl || null,
      requiredPermission: config.accountServiceUrl ? config.authRequiredPermission : null,
    },
  });
});

module.exports = router;
