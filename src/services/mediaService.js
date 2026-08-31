'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../config');

const uploadRoot = path.resolve(config.uploadDir);

/** Path relatif aman? Pastikan berada di dalam uploads/ dan bukan traversal. */
function isInsideUploads(relPath) {
  const abs = path.resolve(uploadRoot, relPath);
  return abs.startsWith(uploadRoot + path.sep);
}

/**
 * Cocokkan signature (magic bytes) berkas dengan format gambar yang didukung.
 * Lapis kedua setelah allowlist mimetype: mimetype dikirim klien dan bisa
 * dipalsukan, sedangkan byte awal berkas tidak.
 */
function detectImageType(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 6 && buf.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/)) return 'gif';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

const mediaService = {
  /**
   * File sudah ditulis multer ke uploads/tmp/. Pindahkan ke uploads/templates/
   * dan kembalikan metadata untuk disimpan di DB / dibalas ke frontend.
   */
  saveUploaded(file) {
    // Baca byte awal berkas yang SUDAH ditulis multer dan pastikan ia benar-benar
    // gambar. Berkas palsu dibuang di sini supaya tidak pernah mendarat di folder
    // yang disajikan publik lewat /uploads.
    const tmpAbs = file.path;
    const fd = fs.openSync(tmpAbs, 'r');
    const head = Buffer.alloc(12);
    try {
      fs.readSync(fd, head, 0, 12, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (!detectImageType(head)) {
      try {
        fs.unlinkSync(tmpAbs);
      } catch (_) {
        // abaikan — yang penting berkas tidak dipindahkan ke folder publik
      }
      const err = new Error('Berkas bukan gambar yang valid (PNG, JPG, GIF, atau WebP)');
      err.statusCode = 400;
      throw err;
    }

    const destRel = path.join('templates', file.filename);
    const destAbs = path.join(uploadRoot, destRel);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.renameSync(file.path, destAbs);
    return {
      mediaPath: destRel,
      mediaUrl: `/uploads/${destRel}`,
      filename: file.originalname,
      size: file.size,
    };
  },

  /** Hapus file media (path relatif di dalam uploads/). */
  delete(relPath) {
    if (!isInsideUploads(relPath)) return;
    const abs = path.resolve(uploadRoot, relPath);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  },

  /**
   * Copy media ke uploads/broadcasts/<id>/ saat create broadcast.
   * Tujuannya: penghapusan template di masa depan tidak merusak history broadcast.
   */
  copyToBroadcast(broadcastId, relPath) {
    const srcAbs = path.resolve(uploadRoot, relPath);
    const destRel = path.join('broadcasts', String(broadcastId), path.basename(relPath));
    const destAbs = path.join(uploadRoot, destRel);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(srcAbs, destAbs);
    return destRel;
  },

  exists(relPath) {
    if (!isInsideUploads(relPath)) return false;
    try {
      return fs.statSync(path.resolve(uploadRoot, relPath)).isFile();
    } catch {
      return false;
    }
  },
};

module.exports = mediaService;
