'use strict';

require('dotenv').config();
const path = require('path');

const ROOT = path.join(__dirname, '..');

const config = {
  root: ROOT,
  port: parseInt(process.env.PORT || '3000', 10),
  dbPath: path.join(ROOT, process.env.DB_PATH || 'db/wa-bot.db'),
  uploadDir: path.join(ROOT, process.env.UPLOAD_DIR || 'uploads'),
  authDir: path.join(ROOT, process.env.AUTH_DIR || '.wwebjs_auth'),
  defaultRatePerMinute: parseInt(process.env.DEFAULT_RATE_PER_MINUTE || '20', 10),
  maxRatePerMinute: parseInt(process.env.MAX_RATE_PER_MINUTE || '3600', 10),
  maxUploadSize: parseInt(process.env.MAX_UPLOAD_SIZE || String(5 * 1024 * 1024), 10),
  // Origin web yang diizinkan CORS (comma-separated); kosong = same-origin
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

module.exports = config;
