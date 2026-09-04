'use strict';

require('dotenv').config();
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * Baca angka dari env, atau HENTIKAN proses dengan pesan yang jelas.
 *
 * Sebelumnya nilai cacat diam-diam lolos sebagai NaN dan baru menampakkan diri
 * di tengah broadcast berjalan. Kasus terburuknya nyata: SEND_MAX_ATTEMPTS yang
 * salah ketik membuat `attempt >= NaN` selalu false, sehingga percobaan ulang
 * pengiriman TIDAK PERNAH berhenti — menembaki WhatsApp tanpa batas.
 *
 * Penjaga lama `Math.max(1, parseInt(...))` terlihat menutup itu, padahal tidak:
 * Math.max(1, NaN) menghasilkan NaN, bukan 1.
 *
 * Salah ketik konfigurasi harus berisik saat start, bukan senyap sampai jam 2 pagi.
 */
function angka(namaEnv, bawaan, { min, max, bulat = false } = {}) {
  const mentah = process.env[namaEnv];
  if (mentah === undefined || mentah === '') return bawaan;

  const nilai = bulat ? Number.parseInt(mentah, 10) : Number.parseFloat(mentah);
  if (!Number.isFinite(nilai)) {
    throw new Error(
      `[config] ${namaEnv}="${mentah}" bukan angka yang sah. ` +
        `Kosongkan untuk memakai bawaan (${bawaan}).`
    );
  }
  if (min !== undefined && nilai < min) {
    throw new Error(`[config] ${namaEnv}=${nilai} di bawah batas minimum ${min}.`);
  }
  if (max !== undefined && nilai > max) {
    throw new Error(`[config] ${namaEnv}=${nilai} melampaui batas maksimum ${max}.`);
  }
  return nilai;
}

const config = {
  root: ROOT,
  port: angka('PORT', 3000, { min: 1, max: 65535, bulat: true }),
  dbPath: path.join(ROOT, process.env.DB_PATH || 'db/wa-bot.db'),
  uploadDir: path.join(ROOT, process.env.UPLOAD_DIR || 'uploads'),
  authDir: path.join(ROOT, process.env.AUTH_DIR || '.wwebjs_auth'),
  defaultRatePerMinute: angka('DEFAULT_RATE_PER_MINUTE', 20, { min: 1, bulat: true }),
  maxRatePerMinute: angka('MAX_RATE_PER_MINUTE', 3600, { min: 1, bulat: true }),
  // Batas atas jeda per pesan (detik). Selain menjaga akal sehat, ini mencegah
  // delayMs melewati batas setTimeout 32-bit (2147483647 ms) — di atas itu Node
  // meng-clamp jadi 1 ms, yang justru menghapus jeda sepenuhnya.
  maxDelaySeconds: angka('MAX_DELAY_SECONDS', 3600, { min: 0 }),
  // Jeda "pemanasan" sebelum pesan PERTAMA sebuah broadcast (detik). Memberi waktu
  // device baru terdaftar stabil di server WhatsApp sebelum kirim massal — mitigasi
  // anti-ban (401 device_removed / logout di tengah kirim). 0 = nonaktif.
  warmupDelaySeconds: angka('WARMUP_DELAY_SECONDS', 0, { min: 0 }),
  // Berapa kali satu pesan dicoba lagi bila GAGAL karena WhatsApp Web sedang
  // memuat ulang halamannya. Hanya berlaku untuk error yang terbukti belum
  // sempat dieksekusi (lihat utils/sendError.js), jadi tidak berisiko membuat
  // pesan terkirim dua kali. 1 = tanpa percobaan ulang.
  sendMaxAttempts: angka('SEND_MAX_ATTEMPTS', 3, { min: 1, bulat: true }),
  // Jeda sebelum percobaan ulang (detik). Suntik-ulang whatsapp-web.js setelah
  // halaman berpindah butuh waktu; mencoba lagi seketika hanya menabrak jendela
  // yang sama.
  sendRetryDelaySeconds: angka('SEND_RETRY_DELAY_SECONDS', 3, { min: 0 }),
  maxUploadSize: angka('MAX_UPLOAD_SIZE', 5 * 1024 * 1024, { min: 1, bulat: true }),
  // ---------------------------------------------------------------- auth
  // URL account-service (shared service). KOSONG = autentikasi NONAKTIF,
  // perilaku lama dipertahankan supaya pemakaian lokal tidak langsung rusak.
  // Server mencetak peringatan mencolok saat kosong — jangan sampai terlewat
  // di production: API ini bisa mengirim WhatsApp dari nomor yang terhubung.
  accountServiceUrl: (process.env.ACCOUNT_SERVICE_URL || '').trim().replace(/\/+$/, ''),
  // Permission yang wajib dipegang untuk memakai API ini. Service key `wa-bot`
  // di account-service otomatis menjadi `wa-bot:*` di dalam JWT.
  authRequiredPermission: (process.env.AUTH_REQUIRED_PERMISSION || 'wa-bot:*').trim(),
  // Penerbit yang diterima; wajib cocok dengan klaim `iss`.
  authIssuer: (process.env.AUTH_ISSUER || 'account-service').trim(),
  // Audience yang ditegakkan. Kosong = tidak diperiksa — account-service
  // sendiri TIDAK memvalidasi `aud`, jadi penegakannya ada di sisi kita.
  authAudience: (process.env.AUTH_AUDIENCE || '').trim(),
  // Toleransi selisih jam antar mesin saat memeriksa exp/nbf (detik).
  authClockToleranceSec: angka('AUTH_CLOCK_TOLERANCE_SECONDS', 30, { min: 0, bulat: true }),
  // Berapa lama PEM kunci publik di-cache. Rotasi tidak menunggu TTL ini:
  // token dengan `kid` asing memicu pengambilan ulang seketika.
  accountPublicKeyTtlMs:
    angka('ACCOUNT_PUBLIC_KEY_TTL_SECONDS', 86400, { min: 1, bulat: true }) * 1000,
  // Cache introspeksi /auth/whoami untuk jalur X-API-Key mentah. Pendek dengan
  // sengaja: jalur ini satu-satunya yang melihat pencabutan kredensial.
  accountWhoamiCacheMs: angka('ACCOUNT_WHOAMI_CACHE_SECONDS', 60, { min: 0, bulat: true }) * 1000,
  accountServiceTimeoutMs: angka('ACCOUNT_SERVICE_TIMEOUT_MS', 5000, { min: 1, bulat: true }),
  // Organisasi yang dipakai saat autentikasi NONAKTIF, supaya lapisan di bawah
  // selalu menerima orgId dan tidak perlu punya cabang "tanpa tenant". Tanpa
  // ini, mode tanpa auth akan menjadi satu-satunya jalur yang melewati
  // penyaringan — persis jalur yang paling mudah lupa diuji.
  authFallbackOrgId: (process.env.AUTH_FALLBACK_ORG_ID || 'local').trim(),

  // Kredensial halaman dokumentasi. Kosong = /docs tidak didaftarkan.
  docsUser: process.env.SWAGGER_USER || '',
  docsPassword: process.env.SWAGGER_PASSWORD || '',

  // Origin web yang diizinkan CORS (comma-separated); kosong = same-origin
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

module.exports = config;
