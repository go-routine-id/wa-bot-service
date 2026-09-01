'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Jeda percobaan ulang dipercepat agar test tidak menunggu detik sungguhan.
process.env.SEND_MAX_ATTEMPTS = '3';
process.env.SEND_RETRY_DELAY_SECONDS = '0.01';

const SRC = path.join(__dirname, '..', 'src');

/** Pasang modul palsu ke require.cache SEBELUM runner di-require. */
function stub(relPath, exports) {
  const full = require.resolve(relPath);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}

/**
 * Bangun runner dengan dependensi palsu.
 * sendBehaviour(attempt) → lempar error, atau kembalikan undefined bila sukses.
 */
function buildRunner(sendBehaviour) {
  // Buang cache supaya tiap test dapat instance bersih (runner menyimpan state).
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC)) delete require.cache[key];
  }

  const status = [];
  let attempts = 0;

  const broadcast = {
    id: 1,
    sessionId: 's1',
    status: 'pending',
    messageText: 'halo',
    mediaPath: null,
    mode: 'parallel',
    ratePerMinute: 60,
    delaySeconds: 0.001,
    sentCount: 0,
    failedCount: 0,
  };
  const final = {};

  stub(path.join(SRC, 'services', 'whatsappService'), {
    sessionExists: () => true,
    isConnected: () => true,
    sendMessage: async () => {
      attempts += 1;
      const err = sendBehaviour(attempts);
      if (err) throw err;
    },
  });

  stub(path.join(SRC, 'repositories', 'broadcastRepository'), {
    // Runner memakai varian tanpa penyaring organisasi — ia proses latar.
    findByIdUnscoped: () => ({ ...broadcast }),
    markRunning: () => {},
    updateCounts: () => {},
    markFailed: (_id, error) => Object.assign(final, { state: 'failed', error }),
    markCompleted: (_id, sent, failed) => Object.assign(final, { state: 'completed', sent, failed }),
  });

  stub(path.join(SRC, 'repositories', 'recipientRepository'), {
    findPending: () => [{ id: 10, recipientNumber: '628123456789', status: 'pending' }],
    updateStatus: (id, patch) => status.push(patch),
    bulkUpdateStatus: () => 0,
  });

  const runner = require(path.join(SRC, 'services', 'broadcastRunner'));
  return { runner, status, final, jumlahPercobaan: () => attempts };
}

/** Tunggu sampai broadcast diberi status akhir (spawnParallel berjalan async). */
async function tungguSelesai(final) {
  for (let i = 0; i < 200; i += 1) {
    if (final.state) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('broadcast tidak pernah selesai');
}

const detachedFrame = () =>
  new Error("Attempted to use detached Frame '03AC1471F500B2F9A64CC4DA0378F488'.");

test('gagal karena frame dilepas → dicoba lagi lalu berhasil', async () => {
  // Persis skenario broadcast #111: WhatsApp Web memuat ulang halamannya tepat
  // saat pesan hendak dikirim. Sebelum perbaikan, ini langsung gagal permanen.
  const { runner, status, final, jumlahPercobaan } = buildRunner((n) =>
    n === 1 ? detachedFrame() : null
  );
  runner.spawnParallel(1);
  await tungguSelesai(final);

  assert.strictEqual(jumlahPercobaan(), 2, 'harus mencoba dua kali');
  const akhir = status[status.length - 1];
  assert.strictEqual(akhir.status, 'sent', `status akhir = ${akhir.status}`);
  assert.strictEqual(final.state, 'completed');
});

test('menyerah setelah batas percobaan, dengan pesan yang bisa dibaca', async () => {
  const { runner, status, final, jumlahPercobaan } = buildRunner(() => detachedFrame());
  runner.spawnParallel(1);
  await tungguSelesai(final);

  assert.strictEqual(jumlahPercobaan(), 3, 'berhenti di SEND_MAX_ATTEMPTS');
  const akhir = status[status.length - 1];
  assert.strictEqual(akhir.status, 'failed');
  assert.ok(!akhir.error.includes('detached Frame'), `pesan masih mentah: ${akhir.error}`);
  assert.match(akhir.error, /memuat ulang/i);
});

test('"Target closed" TIDAK diulang — sekali coba, lalu gagal', async () => {
  // Inti keputusannya: error ini bisa terjadi di tengah panggilan, jadi pesannya
  // mungkin sudah terkirim. Mengulang berisiko penerima dapat pesan dua kali.
  const { runner, status, final, jumlahPercobaan } = buildRunner(
    () => new Error('Protocol error (Runtime.callFunctionOn): Target closed')
  );
  runner.spawnParallel(1);
  await tungguSelesai(final);

  assert.strictEqual(jumlahPercobaan(), 1, 'error ambigu tidak boleh diulang otomatis');
  assert.match(status[status.length - 1].error, /mungkin sudah terkirim/i);
});

test('kegagalan biasa tetap sekali coba', async () => {
  const { runner, status, final, jumlahPercobaan } = buildRunner(
    () => new Error('Phone number is not registered')
  );
  runner.spawnParallel(1);
  await tungguSelesai(final);

  assert.strictEqual(jumlahPercobaan(), 1);
  assert.strictEqual(status[status.length - 1].error, 'Phone number is not registered');
});

test('pesan sukses tidak pernah dikirim dua kali', async () => {
  const { runner, final, jumlahPercobaan } = buildRunner(() => null);
  runner.spawnParallel(1);
  await tungguSelesai(final);
  assert.strictEqual(jumlahPercobaan(), 1);
});
