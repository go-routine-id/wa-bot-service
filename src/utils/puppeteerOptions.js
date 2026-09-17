'use strict';

/**
 * Opsi puppeteer untuk client whatsapp-web.js.
 *
 * handleSIGINT/SIGTERM/SIGHUP sengaja DIMATIKAN. Secara default puppeteer
 * mendaftarkan handler sinyal sendiri yang membunuh Chrome SEKETIKA lalu
 * process.exit(130) — berlomba dengan graceful shutdown milik server.js,
 * yang menutup semua client lewat whatsappService.destroyAll() sebelum exit.
 * Bila handler puppeteer yang menang, Chrome/WhatsApp mati setengah tertutup
 * setiap pm2 restart/deploy. Terverifikasi di pm2.log box: deploy prod
 * 2026-09-10 keluar "exited with code [130] via signal [SIGINT]", dan
 * restart misterius 2026-09-16 keluar code [1] — handler kita tidak sempat
 * menulis satu baris pun di out.log.
 */
function buildPuppeteerOptions() {
  return {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
}

module.exports = { buildPuppeteerOptions };
