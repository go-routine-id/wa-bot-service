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
  // Batas atas jeda per pesan (detik). Selain menjaga akal sehat, ini mencegah
  // delayMs melewati batas setTimeout 32-bit (2147483647 ms) — di atas itu Node
  // meng-clamp jadi 1 ms, yang justru menghapus jeda sepenuhnya.
  maxDelaySeconds: parseFloat(process.env.MAX_DELAY_SECONDS || '3600'),
  // Jeda "pemanasan" sebelum pesan PERTAMA sebuah broadcast (detik). Memberi waktu
  // device baru terdaftar stabil di server WhatsApp sebelum kirim massal — mitigasi
  // anti-ban (401 device_removed / logout di tengah kirim). 0 = nonaktif.
  warmupDelaySeconds: parseFloat(process.env.WARMUP_DELAY_SECONDS || '0'),
  // Berapa kali satu pesan dicoba lagi bila GAGAL karena WhatsApp Web sedang
  // memuat ulang halamannya. Hanya berlaku untuk error yang terbukti belum
  // sempat dieksekusi (lihat utils/sendError.js), jadi tidak berisiko membuat
  // pesan terkirim dua kali. 1 = tanpa percobaan ulang.
  sendMaxAttempts: Math.max(1, parseInt(process.env.SEND_MAX_ATTEMPTS || '3', 10)),
  // Jeda sebelum percobaan ulang (detik). Suntik-ulang whatsapp-web.js setelah
  // halaman berpindah butuh waktu; mencoba lagi seketika hanya menabrak jendela
  // yang sama.
  sendRetryDelaySeconds: parseFloat(process.env.SEND_RETRY_DELAY_SECONDS || '3'),
  maxUploadSize: parseInt(process.env.MAX_UPLOAD_SIZE || String(5 * 1024 * 1024), 10),
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
  authClockToleranceSec: parseInt(process.env.AUTH_CLOCK_TOLERANCE_SECONDS || '30', 10),
  // Berapa lama PEM kunci publik di-cache. Rotasi tidak menunggu TTL ini:
  // token dengan `kid` asing memicu pengambilan ulang seketika.
  accountPublicKeyTtlMs:
    parseInt(process.env.ACCOUNT_PUBLIC_KEY_TTL_SECONDS || '86400', 10) * 1000,
  // Cache introspeksi /auth/whoami untuk jalur X-API-Key mentah. Pendek dengan
  // sengaja: jalur ini satu-satunya yang melihat pencabutan kredensial.
  accountWhoamiCacheMs: parseInt(process.env.ACCOUNT_WHOAMI_CACHE_SECONDS || '60', 10) * 1000,
  accountServiceTimeoutMs: parseInt(process.env.ACCOUNT_SERVICE_TIMEOUT_MS || '5000', 10),
  // Organisasi yang dipakai saat autentikasi NONAKTIF, supaya lapisan di bawah
  // selalu menerima orgId dan tidak perlu punya cabang "tanpa tenant". Tanpa
  // ini, mode tanpa auth akan menjadi satu-satunya jalur yang melewati
  // penyaringan — persis jalur yang paling mudah lupa diuji.
  authFallbackOrgId: (process.env.AUTH_FALLBACK_ORG_ID || 'local').trim(),

  // Origin web yang diizinkan CORS (comma-separated); kosong = same-origin
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

module.exports = config;
