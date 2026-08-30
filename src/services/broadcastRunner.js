'use strict';

const { sleep } = require('../utils/sleep');
const { toChatId } = require('../utils/phone');
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
async function processRecipient(broadcast, recipient) {
  const delayMs = delayForRate(broadcast.ratePerMinute);

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
    recipientRepository.updateStatus(recipient.id, { status: 'failed', error: err.message });
    return 'failed';
  } finally {
    // delay tetap diterapkan setelah tiap percobaan (sukses maupun gagal)
    await sleep(delayMs);
  }
}

/** Jalankan sebuah broadcast sampai selesai/cancel. Dipakai queue (sequential) & parallel. */
async function runBroadcast(broadcastId) {
  let broadcast = broadcastRepository.findById(broadcastId);
  if (!broadcast) return;

  // Broadcast legacy (pra-multi-session, session_id NULL) → kirim via sesi 'utama'.
  broadcast.sessionId = broadcast.sessionId || 'utama';

  if (isCancelled(broadcast.id)) return;

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
      return;
    }
  }

  const recipients = recipientRepository.findPending(broadcast.id);
  for (const recipient of recipients) {
    if (isCancelled(broadcast.id)) break;
    const result = await processRecipient(broadcast, recipient);
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

  const fresh = broadcastRepository.findById(broadcast.id);
  if (!fresh || fresh.status === 'cancelled') return;

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
    try {
      await runBroadcast(next.id);
    } catch (err) {
      console.error(`[runner] queue #${next.id} error:`, err);
      const b = broadcastRepository.findById(next.id);
      if (b && ['pending', 'running'].includes(b.status)) {
        broadcastRepository.markFailed(next.id, err.message, b.sentCount, b.failedCount);
      }
    }
  }
}

function startQueueWorker() {
  if (workerRunning) return;
  workerRunning = true;
  runQueueLoop().catch((err) => console.error('[runner] queue loop berhenti:', err));
}

/** Bangunkan worker saat ada broadcast queue baru. */
function enqueue(broadcastId) {
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
