'use strict';

const config = require('../config');

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

  app.listen(config.port, () => {
    console.log(`[server] berjalan di http://localhost:${config.port}`);
  });
}

// whatsapp-web.js memanggil requestPairingCode() TANPA await dan TANPA .catch()
// (Client.js: pairWithPhoneNumber). Promise itu baru settle saat kode pertama tiba;
// bila halaman/browser ditutup lebih dulu (rescan / hapus sesi), ia reject sebagai
// unhandled rejection. Di Node >= 15 itu mematikan proses — seluruh sesi dan
// broadcast yang sedang jalan ikut mati. Catat & lanjut hidup.
process.on('unhandledRejection', (reason) => {
  console.error('[proses] unhandled rejection (diabaikan, server tetap jalan):', reason);
});

// Graceful shutdown: destroy semua client whatsapp-web.js sebelum exit, supaya
// tidak ada proses Chromium menggantung / sesi setengah terbuka saat restart.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} — menutup WhatsApp client…`);
  try {
    await whatsappService.destroyAll();
  } catch (err) {
    console.error('[shutdown] error destroy:', err);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main();
