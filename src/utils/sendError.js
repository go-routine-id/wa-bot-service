'use strict';

/**
 * Klasifikasi kegagalan pengiriman WhatsApp.
 *
 * whatsapp-web.js mengendalikan WhatsApp Web di dalam Chromium lewat Puppeteer.
 * WhatsApp Web MEMUAT ULANG halamannya sendiri dari waktu ke waktu (sinkronisasi
 * sesi, pembaruan versi, koneksi pulih). Saat itu library menyuntik ulang
 * skripnya — lihat handler `framenavigated` di whatsapp-web.js/src/Client.js.
 * Pengiriman yang kebetulan jatuh di jendela itu gagal dengan error Puppeteer,
 * bukan karena nomornya salah atau WhatsApp menolak.
 *
 * Sebelum ada berkas ini, semua error diperlakukan sama: nomor ditandai gagal
 * permanen dengan pesan mentah seperti
 *   Attempted to use detached Frame '03AC1471F500B2F9A64CC4DA0378F488'.
 * yang tidak berarti apa-apa bagi pengguna.
 */

/**
 * Error yang TERBUKTI belum sempat dieksekusi di dalam halaman.
 *
 * Puppeteer melempar ini ketika HENDAK memakai frame/konteks yang sudah tidak
 * ada — panggilan tidak pernah sampai ke kode WhatsApp Web. Karena itu mencoba
 * ulang TIDAK bisa membuat pesan terkirim dua kali.
 */
const NEVER_EXECUTED_PATTERNS = [
  'detached Frame',
  'Execution context was destroyed',
  'Cannot find context with specified id',
  'Execution context is not available',
];

/**
 * Error yang bisa terjadi DI TENGAH panggilan, jadi status pesannya tidak dapat
 * dipastikan: mungkin sudah masuk ke WhatsApp, mungkin belum.
 *
 * Sengaja TIDAK diulang otomatis. Untuk broadcast, satu penerima yang mendapat
 * pesan dua kali lebih merugikan daripada satu pesan gagal yang bisa dikirim
 * ulang manual — dan pengiriman ganda juga menambah risiko ban. Pesannya tetap
 * diterjemahkan, dan nomornya tetap masuk daftar "kirim ulang yang gagal".
 */
const AMBIGUOUS_PATTERNS = [
  'Target closed',
  'Session closed',
  'Connection closed',
  'Protocol error',
];

/**
 * Nomor tujuan tidak terdaftar di WhatsApp.
 *
 * WhatsApp Web (frontend JS-nya sendiri, bukan library) melempar
 * "No LID for users" ketika mencoba mengirim ke nomor yang tidak punya
 * pemetaan LID — artinya nomor itu memang tidak terdaftar di WhatsApp.
 * Terverifikasi di lapangan: nomor yang memicu error ini dicek manual dan
 * benar-benar tidak punya akun WhatsApp.
 *
 * Bukan masalah sementara: mencoba ulang tidak akan mengubah apa pun.
 */
const NOT_REGISTERED_PATTERNS = [
  'No LID',
];

function matches(message, patterns) {
  return patterns.some((p) => message.includes(p));
}

/**
 * @returns {{ retryable: boolean, message: string }}
 *   retryable — aman dicoba ulang tanpa risiko pesan dobel
 *   message   — pesan yang layak dibaca pengguna
 */
function classifySendError(err) {
  const raw = (err && err.message) || String(err);

  if (matches(raw, NEVER_EXECUTED_PATTERNS)) {
    return {
      retryable: true,
      message: 'WhatsApp Web sedang memuat ulang saat pesan hendak dikirim',
    };
  }

  if (matches(raw, AMBIGUOUS_PATTERNS)) {
    return {
      retryable: false,
      // Disebut apa adanya bahwa statusnya tidak pasti: menyembunyikan keraguan
      // ini akan membuat pengguna mengirim ulang tanpa tahu ada kemungkinan
      // pesannya sudah sampai.
      message:
        'Koneksi ke WhatsApp Web terputus saat mengirim — pesan mungkin sudah terkirim, periksa dulu sebelum mengirim ulang',
    };
  }

  if (matches(raw, NOT_REGISTERED_PATTERNS)) {
    return {
      retryable: false,
      message: 'Nomor tidak terdaftar di WhatsApp',
    };
  }

  return { retryable: false, message: raw };
}

module.exports = { classifySendError };
