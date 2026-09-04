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
/** Tipe hasil deteksi → ekstensi yang dipakai menyimpan berkas. */
const TYPE_EXT = { png: '.png', jpeg: '.jpg', gif: '.gif', webp: '.webp' };

// Ukuran minimum yang masuk akal untuk sebuah gambar. Signature saja tidak cukup:
// berkas 3 byte "FF D8 FF" lolos cek JPEG padahal jelas terpotong, dan kerusakannya
// baru ketahuan saat MessageMedia mengirimkannya ke WhatsApp.
//
// Ambangnya sengaja rendah, dekat ukuran minimum format yang sah: GIF 1x1 sekitar
// 35 byte dan WebP 1x1 sekitar 30 byte — keduanya gambar sungguhan (spacer, ikon
// kecil) yang tidak boleh ikut tertolak.
const MIN_IMAGE_BYTES = 28;

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
   * File sudah ditulis multer ke uploads/tmp/ (tidak tersaji publik — app.js hanya
   * me-mount templates/ dan broadcasts/). Divalidasi isinya lalu dipindah ke uploads/templates/
   * dan kembalikan metadata untuk disimpan di DB / dibalas ke frontend.
   */
  saveUploaded(file) {
    // Baca byte awal berkas yang SUDAH ditulis multer dan pastikan ia benar-benar
    // gambar. Berkas palsu dibuang di sini supaya tidak pernah mendarat di folder
    // yang disajikan publik lewat /uploads.
    const tmpAbs = file.path;

    const dropTmp = () => {
      try {
        fs.unlinkSync(tmpAbs);
      } catch (_) {
        // abaikan — yang penting berkas tidak dipindahkan ke folder publik
      }
    };

    // Baca byte awal. bytesRead WAJIB dipakai: Buffer.alloc(12) selalu berukuran
    // 12 (terisi nol), jadi tanpa ini berkas 3 byte pun lolos semua cek panjang
    // di detectImageType dan gambar terpotong baru ketahuan saat dikirim.
    let head;
    try {
      const fd = fs.openSync(tmpAbs, 'r');
      try {
        const buf = Buffer.alloc(12);
        const bytesRead = fs.readSync(fd, buf, 0, 12, 0);
        head = buf.subarray(0, bytesRead);
      } finally {
        fs.closeSync(fd);
      }
    } catch (_) {
      // Berkas sementara hilang/tak terbaca (disk penuh, cleanup eksternal, EACCES).
      // Balas 400 yang jelas, bukan 500 opaque.
      dropTmp();
      const err = new Error('Berkas upload tidak terbaca — coba unggah ulang');
      err.statusCode = 400;
      throw err;
    }

    // file.size disediakan multer — hindari statSync di sini karena ia berada di
    // luar try/catch di atas, sehingga tmp yang keburu hilang akan melempar ENOENT
    // dan berubah jadi 500 opaque, persis yang ingin dihindari.
    if ((file.size ?? 0) < MIN_IMAGE_BYTES) {
      dropTmp();
      const err = new Error('Berkas gambar terlalu kecil / rusak');
      err.statusCode = 400;
      throw err;
    }

    const detected = detectImageType(head);
    if (!detected) {
      dropTmp();
      const err = new Error('Berkas bukan gambar yang valid (PNG, JPG, GIF, atau WebP)');
      err.statusCode = 400;
      throw err;
    }

    // Ekstensi mengikuti ISI berkas, bukan mimetype kiriman klien. Kalau keduanya
    // berbeda (mis. byte GIF ber-Content-Type image/png), menyimpan sebagai .png
    // membuat express.static mengirim Content-Type salah — dan dengan nosniff
    // browser menolak mengoreksinya sehingga gambar gagal tampil. MessageMedia
    // juga menurunkan mimetype dari ekstensi, jadi WhatsApp ikut menerima label salah.
    const finalName = path.basename(file.filename, path.extname(file.filename)) + TYPE_EXT[detected];
    const destRel = path.join('templates', finalName);
    const destAbs = path.join(uploadRoot, destRel);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    try {
      fs.renameSync(tmpAbs, destAbs);
    } catch (err) {
      if (err.code === 'EXDEV') {
        // Beda filesystem (mis. uploads/ dipasang sebagai volume terpisah):
        // rename tidak bisa, salin lalu hapus sumbernya.
        fs.copyFileSync(tmpAbs, destAbs);
        dropTmp();
      } else {
        dropTmp(); // jangan tinggalkan berkas yatim di folder tmp
        throw err;
      }
    }
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
    // Penjaga ada DI SINI, bukan disandarkan pada sopan-santun pemanggil.
    //
    // Sebelumnya fungsi ini tidak memeriksa apa pun; yang menahannya hanyalah
    // kebetulan bahwa satu-satunya pemanggil selalu memanggil exists() lebih
    // dulu — dan exists() yang dijaga. Pemanggil baru yang lupa urutan itu
    // membuka rantai penuh: berkas mana pun di disk tersalin ke
    // uploads/broadcasts/<id>/, lalu terkirim sebagai lampiran WhatsApp DAN
    // tersaji publik tanpa autentikasi di /uploads/broadcasts/.
    if (!isInsideUploads(relPath)) {
      throw new Error(`[media] path di luar folder uploads ditolak: ${relPath}`);
    }
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
