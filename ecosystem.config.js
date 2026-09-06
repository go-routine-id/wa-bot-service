'use strict';

/**
 * PM2 ecosystem untuk deploy ikavia (lane dev, pola pm2-flat).
 *
 * BEDANYA dengan app pm2 lain di box: service ini STATEFUL — sesi WhatsApp
 * (auth dir) dan SQLite hidup di direktori deploy. Karena itu:
 *  - instances: 1 (fork) — tidak ada cluster mode; dua proses akan rebutan
 *    auth session dan database.
 *  - max_memory_restart SENGAJA tidak di-set: pm2 yang membunuh proses saat
 *    memori tinggi = membunuh sesi WhatsApp yang sedang terhubung. Restart
 *    karena OOM lebih baik ditangani monitor manusia.
 *  - kill_timeout lebar: graceful shutdown menutup semua client whatsapp-web.js
 *    (Chromium) — butuh waktu lebih lama dari kill default pm2 (1.6 dtk).
 */

module.exports = {
  apps: [
    {
      name: 'wa-bot-service-dev',
      script: 'src/server.js',
      cwd: __dirname,
      // PM2 daemon di box jalan di bawah Node 20; tanpa interpreter eksplisit
      // proses baru mewarisi node 20 → better-sqlite3@13 (engines >=22) SIGSEGV
      // di load. Deploy script mengisi WABOT_NODE_BIN dari `nvm which 22`.
      interpreter: process.env.WABOT_NODE_BIN || 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      kill_timeout: 30000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
