'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const sessionRepository = require('../repositories/sessionRepository');

/**
 * Migrasi layout auth pra-multi-session (one-time, di boot):
 * creds.json + keys Baileys tersimpan LANGSUNG di config.authDir →
 * dipindah ke authDir/utama + row sessions('utama').
 *
 * Idempoten: setelah migrasi, authDir/creds.json tidak ada lagi → no-op.
 * Kalau state partial (folder utama sudah ada, creds masih di root) → merge file.
 */
function migrateLegacyAuth() {
  const legacyDir = config.authDir;
  const legacyCreds = path.join(legacyDir, 'creds.json');
  if (!fs.existsSync(legacyCreds)) return; // bukan layout lama / sudah dimigrasi
  if (sessionRepository.findById('utama')) return; // row sudah ada → jangan seed ulang

  const target = path.join(legacyDir, 'utama');
  fs.mkdirSync(legacyDir, { recursive: true });

  if (fs.existsSync(target)) {
    // Keadaan partial: folder utama sudah dibuat tapi creds legacy masih di root.
    for (const entry of fs.readdirSync(legacyDir)) {
      if (entry === 'utama') continue;
      fs.renameSync(path.join(legacyDir, entry), path.join(target, entry));
    }
  } else {
    fs.renameSync(legacyDir, target);
  }

  sessionRepository.create({ id: 'utama', name: 'utama' });
  console.log('[auth] migrasi session WhatsApp legacy → sesi "utama"');
}

module.exports = { migrateLegacyAuth };
