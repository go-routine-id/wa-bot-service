'use strict';

const express = require('express');
const path = require('path');
const config = require('../config');
const apiRoutes = require('./routes');
const { corsMiddleware } = require('./middleware/cors');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(express.json());
// CORS configurable (env CORS_ORIGINS); kosong = same-origin. Dipasang sebelum route
// supaya preflight OPTIONS lintas-origin ditangani (204) sebelum masuk routing.
app.use(corsMiddleware);
// Hanya subfolder publik yang di-mount — BUKAN seluruh uploadDir. uploads/tmp/
// berisi berkas mentah yang belum divalidasi isinya; kalau ikut tersaji, siapa pun
// bisa mengunduhnya di sela antara multer menulis dan pemeriksaan magic bytes.
// nosniff: lapis terakhir agar browser tidak menebak-nebak tipe berkas.
const nosniff = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
};
app.use('/uploads/templates', nosniff, express.static(path.join(config.uploadDir, 'templates')));
app.use('/uploads/broadcasts', nosniff, express.static(path.join(config.uploadDir, 'broadcasts')));
// API di-polling frontend tiap 2.5 detik → larang caching kondisional: 304
// ber-body kosong memecahkan klien yang tidak menangani cache transparan
// (api.js membaca res.ok + res.json — 304 bukan 2xx → error "HTTP 304" palsu).
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', apiRoutes);

// 404 fallback (harus setelah semua route)
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint tidak ditemukan' });
});

app.use(errorHandler);

module.exports = app;
