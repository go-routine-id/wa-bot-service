'use strict';

const path = require('path');
const express = require('express');
const config = require('../config');
const apiRoutes = require('./routes');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(express.json());
app.use('/uploads', express.static(config.uploadDir));
app.use(express.static(path.join(config.root, 'public')));
app.use('/api', apiRoutes);

// 404 fallback (harus setelah semua route)
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint tidak ditemukan' });
});

app.use(errorHandler);

module.exports = app;
