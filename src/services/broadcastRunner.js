'use strict';

const { sleep } = require('../utils/sleep');
const { toChatId } = require('../utils/phone');
const { classifySendError } = require('../utils/sendError');
const config = require('../../config');
const whatsappService = require('./whatsappService');
const broadcastRepository = require('../repositories/broadcastRepository');
const recipientRepository = require('../repositories/recipientRepository');

/** Flag cancel per broadcast (in-memory; status final di DB jadi sumber kebenaran). */
const cancelFlags = new Map();

/** Notifier untuk queue worker agar langsung bangun saat ada broadcast baru. */
let queueWake = null;

function setCancelled(id, value) {
  cancelFlags.set(id, value);
}

function isCancelled(id) {
  return cancelFlags.get(id) === true;
}

function clearFlag(id) {
  cancelFlags.delete(id);
}

function delayForRate(ratePerMinute) {
  return Math.floor(60000 / ratePerMinute);
}

/** Batas aman setTimeout (32-bit signed). Di atas ini Node meng-clamp jadi 1 ms. */
const MAX_TIMEOUT_MS = 2147483647;

/**
 * Batas tunggu koneksi pulih SEBELUM percobaan ulang. Lebih pendek dari tunggu
 * awal (2 menit): di sini sesi tadi sudah terhubung dan hanya sedang menyuntik
 * ulang setelah halaman berpindah — kalau lebih lama dari ini, masalahnya bukan
 * lagi sekadar muat ulang, dan menahan seluruh antrian tidak ada gunanya.
 */
const RETRY_CONNECT_TIMEOUT_MS = 30 * 1000;

/**
 * Jeda antar pesan (ms) untuk sebuah broadcast. Bila delay_seconds tersimpan
 * (mode "jeda per pesan"), pakai nilai presisinya; selain itu derive dari
 * rate_per_minute.
 */
function delayForBroadcast(broadcast) {
  const raw =
    broadcast.delaySeconds != null && broadcast.delaySeconds > 0
      ? Math.round(broadcast.delaySeconds * 1000)
      : delayForRate(broadcast.ratePerMinute);
  // Backstop: validasi input sudah membatasi delaySeconds, tapi baris lama di DB
  // (atau perubahan config) bisa melampaui kapasitas setTimeout — clamp ke batas
  // aman supaya jeda besar TIDAK malah berubah jadi 1 ms.
  return Math.min(raw, MAX_TIMEOUT_MS);
}

/**
 * Tunggu hingga sesi pengirim broadcast terhubung (maks timeoutMs).
 * Kembalikan false bila cancel / sesi dihapus / timeout.
 * Terima object `broadcast` agar bisa cek sessionId (fail-fast bila sesi hilang).
 */
async function waitForConnection(broadcast, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isCancelled(broadcast.id)) return false;
    if (!whatsappService.sessionExists(broadcast.sessionId)) return false; // sesi dihapus → fail cepat
    if (whatsappService.isConnected(broadcast.sessionId)) return true;
    await sleep(1000);
  }
  return false;
}

/**
 * Proses satu recipient.
 * return: 'sent' | 'failed' | 'stopped' (stopped = cancel / koneksi fatal).
 */
async function processRecipient(broadcast, recipient, { applyDelay = true } = {}) {
  const delayMs = applyDelay ? delayForBroadcast(broadcast) : 0;

  if (isCancelled(broadcast.id)) return 'stopped';

  const connected = await waitForConnection(broadcast, 2 * 60 * 1000);
  if (!connected) {
    if (isCancelled(broadcast.id)) return 'stopped';
    // Bedakan: sesi dihapus vs sesi ada tapi putus → pesan failed yang jelas.
    const msg = whatsappService.sessionExists(broadcast.sessionId)
      ? 'WhatsApp tidak terhubung'
      : 'Sesi pengirim tidak ditemukan';
    recipientRepository.updateStatus(recipient.id, { status: 'failed', error: msg });
    return 'fatal';
  }
  if (isCancelled(broadcast.id)) return 'stopped';

  recipientRepository.updateStatus(recipient.id, { status: 'sending' });
  try {
    // WhatsApp Web kadang memuat ulang halamannya sendiri, dan pengiriman yang
    // jatuh tepat di jendela itu gagal karena frame-nya sudah dilepas. Kegagalan
    // seperti itu bukan soal nomornya, dan terbukti belum sempat dieksekusi —
    // jadi dicoba lagi, bukan langsung ditandai gagal permanen.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await whatsappService.sendMessage(broadcast.sessionId, toChatId(recipient.recipientNumber), {
          text: broadcast.messageText,
          mediaPath: broadcast.mediaPath,
        });
        recipientRepository.updateStatus(recipient.id, {
          status: 'sent',
          sentAt: new Date().toISOString(),
        });
        return 'sent';
      } catch (err) {
        const { retryable, message } = classifySendError(err);
        const lastAttempt = attempt >= config.sendMaxAttempts;

        if (!retryable || lastAttempt) {
          if (retryable) {
            console.error(
              `[runner] #${broadcast.id} ${recipient.recipientNumber}: menyerah setelah ${attempt} percobaan — ${message}`
            );
          }
          recipientRepository.updateStatus(recipient.id, { status: 'failed', error: message });
          return 'failed';
        }

        console.warn(
          `[runner] #${broadcast.id} ${recipient.recipientNumber}: ${message}, coba lagi (${attempt}/${config.sendMaxAttempts})`
        );
        await sleep(Math.round(config.sendRetryDelaySeconds * 1000));

        // Pembatalan diperiksa SETELAH jeda: broadcast bisa dibatalkan selagi
        // menunggu, dan meneruskan percobaan berikutnya berarti mengirim pesan
        // yang sudah diminta berhenti.
        if (isCancelled(broadcast.id)) return 'stopped';

        // Halaman baru saja dimuat ulang; suntikan whatsapp-web.js perlu waktu
        // sampai siap. Mencoba tanpa menunggu hanya menabrak jendela yang sama.
        if (!(await waitForConnection(broadcast, RETRY_CONNECT_TIMEOUT_MS))) {
          if (isCancelled(broadcast.id)) return 'stopped';
          recipientRepository.updateStatus(recipient.id, {
            status: 'failed',
            error: 'WhatsApp tidak terhubung kembali setelah memuat ulang',
          });
          return 'failed';
        }
      }
    }
  } finally {
    // Delay diterapkan setelah tiap percobaan (sukses maupun gagal), KECUALI
    // setelah recipient terakhir — menunggu di sana hanya menahan broadcast di
    // status 'running' tanpa gunanya (bisa sampai 1 jam dengan jeda besar).
    if (delayMs > 0) await sleep(delayMs);
  }
}

/**
 * Jalankan sebuah broadcast sampai selesai/cancel. Dipakai queue (sequential) & parallel.
 * Mengembalikan JUMLAH PESAN yang benar-benar terkirim di run ini — queue worker
 * memakainya untuk memutuskan perlu-tidaknya jeda sebelum broadcast berikutnya.
 */
async function runBroadcast(broadcastId) {
  let broadcast = broadcastRepository.findById(broadcastId);
  if (!broadcast) {
    clearFlag(broadcastId); // jangan tinggalkan flag yatim di memori
    return 0;
  }

  // Broadcast legacy (pra-multi-session, session_id NULL) → kirim via sesi 'utama'.
  broadcast.sessionId = broadcast.sessionId || 'utama';

  // Status DB ikut diperiksa: broadcast yang sudah dibatalkan sebelum runner
  // sempat jalan tidak boleh diproses, dan flag-nya dibersihkan di sini.
  if (isCancelled(broadcast.id) || broadcast.status === 'cancelled') {
    clearFlag(broadcast.id);
    return 0;
  }

  broadcastRepository.markRunning(broadcast.id);
  broadcast = broadcastRepository.findById(broadcast.id); // re-read (started_at dll.)

  let sentCount = broadcast.sentCount;
  let failedCount = broadcast.failedCount;
  let fatal = false;

  // Warm-up: jeda pemanasan sebelum pesan pertama (mitigasi anti-ban untuk device
  // baru). Cek cancel sesudahnya supaya broadcast yang dibatalkan saat warmup
  // tidak lanjut kirim.
  const warmupMs = Math.round(config.warmupDelaySeconds * 1000);
  if (warmupMs > 0 && !isCancelled(broadcast.id)) {
    console.log(
      `[runner] #${broadcast.id} warm-up ${config.warmupDelaySeconds}s sebelum pesan pertama…`
    );
    await sleep(warmupMs);
    if (isCancelled(broadcast.id)) {
      clearFlag(broadcast.id);
      return 0;
    }
  }

  const recipients = recipientRepository.findPending(broadcast.id);
  for (let i = 0; i < recipients.length; i += 1) {
    const recipient = recipients[i];
    if (isCancelled(broadcast.id)) break;
    const isLast = i === recipients.length - 1;
    const result = await processRecipient(broadcast, recipient, { applyDelay: !isLast });
    if (result === 'sent') sentCount += 1;
    else if (result === 'failed') failedCount += 1;
    else if (result === 'stopped') break;
    else if (result === 'fatal') {
      fatal = true;
      break;
    }
    broadcastRepository.updateCounts(broadcast.id, sentCount, failedCount);
  }

  clearFlag(broadcast.id);

  const sentThisRun = sentCount - broadcast.sentCount; // dipakai queue untuk memberi jarak
  const fresh = broadcastRepository.findById(broadcast.id);
  if (!fresh || fresh.status === 'cancelled') return sentThisRun;

  if (fatal) {
    // Recipient yang memicu fatal sudah di-mark 'failed' oleh processRecipient
    // tapi tidak masuk hitungan loop → tambahkan manual supaya count akurat.
    failedCount += 1;
    // Sisa recipient yang masih 'pending' ikut di-mark 'failed' — sebelumnya
    // mereka selamanya stuck di 'pending' (retry & recovery hanya memproses
    // status 'failed') sehingga tidak pernah bisa dikirim ulang. Dengan ini
    // tombol "Kirim ulang yang gagal" menangkapnya.
    failedCount += recipientRepository.bulkUpdateStatus(
      broadcast.id,
      ['pending', 'sending'],
      'failed',
      'Broadcast dihentikan karena koneksi putus'
    );
    broadcastRepository.markFailed(
      broadcast.id,
      'WhatsApp tidak terhubung saat broadcast berjalan',
      sentCount,
      failedCount
    );
  } else {
    broadcastRepository.markCompleted(broadcast.id, sentCount, failedCount);
  }
  return sentThisRun;
}

/* ---------------- Queue worker (mode 'queue', FIFO, satu per satu) ---------------- */

let workerRunning = false;

function waitForQueueSignal() {
  return new Promise((resolve) => {
    queueWake = resolve;
  });
}

async function runQueueLoop() {
  while (workerRunning) {
    const next = broadcastRepository.findNextQueued();
    if (!next) {
      await waitForQueueSignal();
      continue;
    }
    let sentThisRun = 0;
    try {
      sentThisRun = await runBroadcast(next.id);
    } catch (err) {
      console.error(`[runner] queue #${next.id} error:`, err);
      const b = broadcastRepository.findById(next.id);
      if (b && ['pending', 'running'].includes(b.status)) {
        broadcastRepository.markFailed(next.id, err.message, b.sentCount, b.failedCount);
      }
    }
    // Jeda ANTAR broadcast. processRecipient sengaja melewati jeda setelah pesan
    // terakhir supaya broadcast tidak menggantung di status 'running'; tanpa jeda
    // di sini, pesan terakhir broadcast ini dan pesan pertama broadcast berikutnya
    // keluar beruntun tanpa jarak sama sekali — melubangi plafon anti-ban.
    //
    // Hanya bila broadcast tadi BENAR-BENAR mengirim: kalau ia dibatalkan atau
    // gagal total (0 terkirim), tidak ada apa pun yang perlu diberi jarak dan
    // menahan antrian sampai MAX_DELAY_SECONDS hanya membekukan queue percuma.
    if (sentThisRun > 0 && workerRunning && broadcastRepository.findNextQueued()) {
      await sleep(delayForBroadcast(next));
    }
  }
}

function startQueueWorker() {
  if (workerRunning) return;
  workerRunning = true;
  runQueueLoop().catch((err) => console.error('[runner] queue loop berhenti:', err));
}

/** Bangunkan worker saat ada broadcast queue baru (worker sendiri yang memilih FIFO). */
function enqueue() {
  if (queueWake) {
    const wake = queueWake;
    queueWake = null;
    wake();
  }
}

/* ---------------- Parallel runner (mode 'parallel', jalan mandiri) ---------------- */

function spawnParallel(broadcastId) {
  setImmediate(() => {
    runBroadcast(broadcastId).catch((err) => {
      console.error(`[runner] parallel #${broadcastId} error:`, err);
      const b = broadcastRepository.findById(broadcastId);
      if (b && ['pending', 'running'].includes(b.status)) {
        broadcastRepository.markFailed(broadcastId, err.message, b.sentCount, b.failedCount);
      }
    });
  });
}

module.exports = {
  startQueueWorker,
  enqueue,
  spawnParallel,
  setCancelled,
  isCancelled,
};
