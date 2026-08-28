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
  // WhatsApp client: fire-and-forget, status 'qr'/'connected' muncul async
  whatsappService.start().catch((err) => {
    console.error('[boot] whatsapp start error:', err);
  });

  // Pulihkan broadcast yang tertinggal saat restart, lalu nyalakan queue worker
  broadcastService.recoverInProgress();
  broadcastRunner.startQueueWorker();

  app.listen(config.port, () => {
    console.log(`[server] berjalan di http://localhost:${config.port}`);
  });
}

// Graceful shutdown: hentikan socket Baileys sebelum exit, supaya tidak ada
// koneksi WebSocket menggantung / sesi setengah terbuka saat restart.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} — menutup WhatsApp client…`);
  try {
    await whatsappService.destroy();
  } catch (err) {
    console.error('[shutdown] error destroy:', err);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main();
