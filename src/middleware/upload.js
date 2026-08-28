'use strict';

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../../config');

const tmpDir = path.join(config.uploadDir, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tmpDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadSize, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(Object.assign(new Error('Hanya file gambar yang diizinkan (image/*)'), { statusCode: 400 }));
  },
});

/** Bungkus multer agar error (ukuran/jenis) → 400 JSON, bukan crash. */
function uploadSingleImage(fieldName) {
  const mw = upload.single(fieldName);
  return (req, res, next) => {
    mw(req, res, (err) => {
      if (!err) return next();
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? `Ukuran file melebihi batas ${Math.round(config.maxUploadSize / 1024 / 1024)}MB`
          : err.message;
      res.status(err.statusCode || 400).json({ error: msg });
    });
  };
}

module.exports = { upload, uploadSingleImage };
