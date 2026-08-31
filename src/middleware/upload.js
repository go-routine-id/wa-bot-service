'use strict';

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../../config');

// DI LUAR uploadDir: express.static menyajikan seluruh isi uploadDir, sedangkan
// multer menulis berkas mentah ke sini SEBELUM isinya divalidasi. Kalau tmp berada
// di dalamnya, berkas yang belum diperiksa sempat bisa diunduh siapa pun lewat
// /uploads/tmp/<nama>, dan menetap permanen bila penghapusannya gagal.
const tmpDir = path.join(config.root, '.upload-tmp');
fs.mkdirSync(tmpDir, { recursive: true });

/**
 * Tipe gambar yang diizinkan → ekstensi yang DIPAKSAKAN.
 *
 * Ekstensi TIDAK boleh diambil dari file.originalname: mimetype dikirim klien
 * (bisa dipalsukan), sehingga `evil.html` ber-Content-Type `image/png` dulu
 * tersimpan sebagai .html lalu disajikan express.static sebagai text/html —
 * script-nya berjalan di origin API. Dengan memaksa ekstensi dari daftar ini,
 * berkas apa pun paling banter tersaji sebagai gambar rusak, bukan HTML.
 */
const ALLOWED_IMAGE_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tmpDir),
  filename: (req, file, cb) => {
    const ext = ALLOWED_IMAGE_TYPES[file.mimetype.toLowerCase()] || '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadSize, files: 1 },
  fileFilter: (req, file, cb) => {
    // Allowlist eksplisit, bukan sekadar startsWith('image/') — 'image/svg+xml'
    // pun sebenarnya bisa memuat script bila tersaji langsung.
    if (ALLOWED_IMAGE_TYPES[file.mimetype.toLowerCase()]) return cb(null, true);
    cb(
      Object.assign(new Error('Hanya PNG, JPG, GIF, atau WebP yang diizinkan'), {
        statusCode: 400,
      })
    );
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

module.exports = { upload, uploadSingleImage, ALLOWED_IMAGE_TYPES };
