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

const mediaService = {
  /**
   * File sudah ditulis multer ke uploads/tmp/. Pindahkan ke uploads/templates/
   * dan kembalikan metadata untuk disimpan di DB / dibalas ke frontend.
   */
  saveUploaded(file) {
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
