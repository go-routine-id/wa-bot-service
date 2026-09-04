'use strict';

const config = require('../config');
const { mulaiGrpc } = require('./grpc/server');

// Init DB + migrasi (wajib sebelum repository/service dipakai)
const { getDb } = require('../config/database');
getDb();

const whatsappService = require('./services/whatsappService');
const broadcastService = require('./services/broadcastService');
const broadcastRunner = require('./services/broadcastRunner');
const app = require('./app');

async function main() {
  // Start semua sesi yang punya creds tersimpan (fire-and-forget, status
  // 'connected' muncul async). Sesi tanpa creds tidak di-start (anti pairing-loop).
  whatsappService.startAll();

  // Pulihkan broadcast yang tertinggal saat restart, lalu nyalakan queue worker.
  // startAll() harus jalan DULU: runner menunggu koneksi per-sesi saat recovery.
  broadcastService.recoverInProgress();
  broadcastRunner.startQueueWorker();

  // Jalur gRPC (server-to-server). Satu proses dengan HTTP — lihat komentar di
  // src/grpc/server.js soal state runner yang hidup di memori.
  grpcServer = await mulaiGrpc();

  app.listen(config.port, () => {
    console.log(`[server] berjalan di http://localhost:${config.port}`);
    if (config.accountServiceUrl) {
      console.log(
        `[auth] aktif — verifikasi JWT ke ${config.accountServiceUrl}, izin wajib: ${config.authRequiredPermission}`
      );
    } else {
      // Dicetak mencolok dengan sengaja. API ini bisa mengirim WhatsApp dari
      // nomor yang terhubung, jadi berjalan tanpa autentikasi di lingkungan yang
      // bisa dijangkau orang lain adalah kondisi yang tidak boleh terlewat.
      console.warn(
        '[auth] ⚠️  NONAKTIF — ACCOUNT_SERVICE_URL kosong, SELURUH /api terbuka tanpa kredensial'
      );
    }
  });
}

// whatsapp-web.js memanggil requestPairingCode() TANPA await dan TANPA .catch()
// (Client.js: pairWithPhoneNumber). Promise itu baru settle saat kode pertama tiba;
// bila halaman/browser ditutup lebih dulu (rescan / hapus sesi), ia reject sebagai
// unhandled rejection. Di Node >= 15 itu mematikan proses — seluruh sesi dan
// broadcast yang sedang jalan ikut mati.
//
// Yang ditoleransi HANYA rejection yang berasal dari library itu / puppeteer.
// Rejection dari kode kita sendiri tetap dibiarkan mematikan proses (pm2 me-restart),
// karena menelan semuanya akan menyembunyikan bug nyata — mis. tulisan DB yang gagal
// di jalur tak ter-await bisa meninggalkan queue worker dalam keadaan tak konsisten
// sambil hanya meninggalkan satu baris log.
const TOLERATED_REJECTION_SOURCES = ['whatsapp-web.js', 'puppeteer'];

process.on('unhandledRejection', (reason) => {
  const stack = (reason && (reason.stack || reason.message)) || String(reason);
  const fromLibrary = TOLERATED_REJECTION_SOURCES.some((src) => String(stack).includes(src));
  if (fromLibrary) {
    console.error('[proses] unhandled rejection dari library WhatsApp (diabaikan):', stack);
    return;
  }
  console.error('[proses] unhandled rejection TAK DIKENAL — proses dihentikan:', stack);
  throw reason instanceof Error ? reason : new Error(String(stack));
});

// Graceful shutdown: destroy semua client whatsapp-web.js sebelum exit, supaya
// tidak ada proses Chromium menggantung / sesi setengah terbuka saat restart.
let grpcServer = null;
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} — menutup WhatsApp client…`);
  try {
    // gRPC ditutup DULU: hentikan permintaan baru masuk sebelum sesi WhatsApp
    // dibongkar, supaya tidak ada handler yang berjalan di atas klien yang
    // sedang dimatikan.
    if (grpcServer) grpcServer.forceShutdown();
    await whatsappService.destroyAll();
  } catch (err) {
    console.error('[shutdown] error destroy:', err);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main();
