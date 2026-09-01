'use strict';

/**
 * Penjaga tenant untuk seluruh repository.
 *
 * Setiap query yang menyentuh data milik pengguna WAJIB menyaring
 * `owner_org_id`. Lupa satu saja berarti satu organisasi bisa membaca — atau
 * menghapus — data organisasi lain, dan kebocoran seperti itu tidak menimbulkan
 * error apa pun: query-nya sukses, hasilnya saja yang salah.
 *
 * Karena itu orgId dijadikan argumen WAJIB dan ketiadaannya melempar. Lubang
 * keamanan yang senyap diubah jadi crash yang langsung terlihat saat
 * pengembangan, bukan insiden yang baru ketahuan dari laporan pelanggan.
 */
function requireOrg(orgId, where) {
  if (typeof orgId !== 'string' || orgId.trim() === '') {
    throw new Error(
      `[tenant] orgId wajib diisi di ${where} — query tanpa penyaring organisasi ditolak`
    );
  }
  return orgId;
}

module.exports = { requireOrg };
