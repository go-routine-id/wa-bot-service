'use strict';

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const config = require('../../config');
const sessionRepository = require('../repositories/sessionRepository');
const { HttpError } = require('../utils/httpError');

// Backoff reconnect untuk sesi established (blip koneksi / page close). Cap 30s,
// ulang terus sampai stopReconnect (destroy/logout/delete) atau auth_failure.
const RECONNECT_DELAYS = [3000, 5000, 10000, 20000, 30000]; // ms

// whatsapp-web.js meregenerasi kode pairing tiap interval ini (default library 3
// menit). Dipakai juga sebagai masa berlaku yang ditampilkan di UI.
const PAIRING_CODE_INTERVAL_MS = 3 * 60 * 1000;

// Batas menunggu start() yang masih in-flight sebelum memulai yang baru, dan
// batas menutup client. Keduanya dijaga kecil supaya total waktu handler HTTP
// tetap jauh di bawah timeout fetch browser.
const START_SETTLE_TIMEOUT_MS = 8000;
const DESTROY_TIMEOUT_MS = 8000;

/**
 * Registry sesi runtime. Sumber kebenaran keberadaan sesi = tabel `sessions`;
 * Map ini hanya state client/status/QR per sesi.
 * Map<sessionId, SessionState>
 */
const registry = new Map();

/* ---------------- helpers ---------------- */

function ensureAuthDir() {
  fs.mkdirSync(config.authDir, { recursive: true });
}

/**
 * Apakah sesi punya pairing WhatsApp yang valid & bisa di-resume?
 *
 * whatsapp-web.js (LocalAuth) menyimpan sesi di dalam profil Chromium
 * (`<authDir>/session-<id>/`) lewat IndexedDB — struktur itu tidak mudah
 * dibedakan dari profil yang baru dibuat (belum ter-pair). Karena itu kita tulis
 * marker `.linked` saat event `authenticated` (session berhasil disimpan ke
 * LocalAuth). Marker ini = "pairing pernah sukses & kredensial tersimpan".
 *
 * Tanpa marker ini, sesi valid yang baru saja di-restart bisa salah dikira
 * "belum ter-pair" → dipaksa scan QR ulang setiap boot.
 *
 * JANGAN menambah fallback "ada folder Default/IndexedDB/https_web.whatsapp.com":
 * folder itu dibuat Chromium begitu web.whatsapp.com dimuat — yaitu untuk
 * MENGGAMBAR QR — jadi sesi yang belum pernah ter-pair pun memilikinya. Fallback
 * seperti itu membuat hasCreds selalu true dan merusak banyak hal sekaligus:
 * requestPairingCode ditolak 409, startAll otomatis membuka QR saat boot, rescan
 * berhenti membersihkan profil rusak, dan sesi tak ter-pair masuk loop reconnect.
 * Pembeda yang sah hanya sesuatu yang ditulis SETELAH pairing sukses.
 */
function hasCreds(id) {
  return fs.existsSync(path.join(config.authDir, `session-${id}`, '.linked'));
}

/**
 * Sesi ADA di database — lintas organisasi, tanpa otorisasi.
 *
 * Dipakai runner latar dan pemeriksaan keunikan slug. Otorisasi dilakukan
 * terpisah lewat assertOwned() di pintu HTTP.
 */
function sessionExists(id) {
  return !!sessionRepository.findByIdUnscoped(id);
}

/**
 * Pastikan sesi ini milik organisasi pemanggil.
 *
 * Melempar 404 — BUKAN 403 — untuk sesi milik organisasi lain. Membalas 403
 * akan memberi tahu bahwa id itu ada di suatu tempat, dan itu sudah kebocoran:
 * penyerang bisa menebak-nebak slug untuk memetakan tenant lain.
 */
function assertOwned(id, orgId) {
  const row = sessionRepository.findById(id, orgId);
  if (!row) throw new HttpError(404, 'Sesi tidak ditemukan');
  return row;
}

function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'sesi'
  );
}

/** Slug unik terhadap tabel sessions + folder auth (backstop saat crash/partial). */
function generateUniqueSlug(name) {
  const base = slugify(name);
  let id = base;
  let n = 2;
  while (
    // Lintas organisasi dengan sengaja: slug dipakai sebagai nama folder
    // kredensial di disk, jadi bentrok antar tenant akan membuat dua organisasi
    // berbagi satu folder sesi WhatsApp.
    sessionRepository.findByIdUnscoped(id) ||
    fs.existsSync(path.join(config.authDir, `session-${id}`))
  ) {
    id = `${base}-${n++}`;
  }
  return id;
}

function createSession(id, name) {
  return {
    id,
    name,
    authDir: path.join(config.authDir, `session-${id}`),
    // uninitialized | connecting | qr | pairing_code | connected | disconnected | auth_failure
    status: 'uninitialized',
    qrDataUrl: null,
    qrExpiresAt: null,
    pairingPhone: null, // nomor tujuan jalur kode pairing; null = jalur QR biasa
    pairingCode: null, // kode 8 karakter dari event 'code'
    pairingCodeExpiresAt: null,
    userInfo: null,
    lastError: null,
    client: null, // instance whatsapp-web.js Client aktif
    starting: null, // promise start() berjalan (cegah race membuat 2 client per sesi)
    reconnectTimer: null, // timer auto-reconnect backoff
    reconnectAttempts: 0,
    stopReconnect: false, // true saat destroy/logout/delete; false saat start ulang
    gen: 0, // naik tiap destroy/rescan/delete → start() in-flight dibatalkan (fix race)
  };
}

/* ---------------- timer per-sesi ---------------- */

function clearReconnect(sess) {
  if (sess.reconnectTimer) {
    clearTimeout(sess.reconnectTimer);
    sess.reconnectTimer = null;
  }
  sess.reconnectAttempts = 0;
}

function scheduleReconnect(sess) {
  if (sess.stopReconnect || sess.reconnectTimer) return;
  const delay = RECONNECT_DELAYS[Math.min(sess.reconnectAttempts, RECONNECT_DELAYS.length - 1)];
  sess.reconnectAttempts += 1;
  sess.reconnectTimer = setTimeout(() => {
    sess.reconnectTimer = null;
    if (sess.stopReconnect) return;
    console.log(`[wa:${sess.id}] mencoba koneksi ulang…`);
    // start() menelan hampir semua error di dalam (reject initialize → scheduleReconnect
    // internal). .catch() ini cuma safety net untuk `new Client()` yang throw sinkron.
    start(sess.id).catch((err) => {
      console.error(`[wa:${sess.id}] reconnect gagal:`, err.message);
      scheduleReconnect(sess);
    });
  }, delay);
}

/* ---------------- event client per-sesi ---------------- */

/**
 * Pasang listener event whatsapp-web.js untuk satu sesi.
 * `gen` ditangkap saat wiring; event dari client lama (usai rescan/delete)
 * diabaikan via pengecekan `sess.gen !== gen` dan `sess.client !== client`.
 */
function wireClientEvents(sess, client, gen) {
  client.on('qr', async (qr) => {
    if (sess.gen !== gen || sess.client !== client) return;
    let dataUrl = null;
    try {
      dataUrl = await QRCode.toDataURL(qr);
    } catch (err) {
      console.error(`[wa:${sess.id}] gagal generate QR:`, err.message);
    }
    // toDataURL async: client bisa sudah di-destroy selama await. Tanpa re-check,
    // QR basi "bangkit" menempel di state.
    if (sess.gen !== gen || sess.client !== client) return;
    sess.status = 'qr';
    sess.qrDataUrl = dataUrl;
    // qrMaxRetries: 0 berarti refresh TANPA BATAS (cabang batas hanya jalan bila > 0),
    // jadi QR memang berotasi dan handler ini menimpa qrDataUrl tiap kali. Tidak ada
    // TTL yang kita kelola sendiri — konsumen harus polling /status, bukan meng-cache
    // gambar QR pertama.
    sess.qrExpiresAt = null;
    sess.lastError = null;
  });

  // Jalur kode pairing: library memancarkan kode 8 karakter dan meregenerasinya
  // tiap PAIRING_CODE_INTERVAL_MS selama belum dipakai.
  client.on('code', (code) => {
    if (sess.gen !== gen || sess.client !== client) return;
    sess.status = 'pairing_code';
    sess.pairingCode = code;
    sess.pairingCodeExpiresAt = Date.now() + PAIRING_CODE_INTERVAL_MS;
    sess.qrDataUrl = null;
    sess.lastError = null;
    console.log(`[wa:${sess.id}] kode pairing dibuat:`, code);
  });

  // Session berhasil diautentikasi & disimpan ke LocalAuth → tulis marker valid.
  client.on('authenticated', () => {
    if (sess.gen !== gen || sess.client !== client) return;
    try {
      fs.writeFileSync(path.join(sess.authDir, '.linked'), String(Date.now()));
    } catch (err) {
      // Marker ini SATU-SATUNYA penanda sesi ter-pair (lihat hasCreds). Kalau
      // penulisannya gagal, sesi tidak akan di-start saat boot dan "Hubungkan"
      // justru MENGHAPUS profil yang sebenarnya masih sah. Jadi jangan ditelan
      // diam-diam — teriakkan di log dan tampilkan ke user.
      console.error(`[wa:${sess.id}] GAGAL menulis marker .linked:`, err.message);
      sess.lastError =
        'Sesi terhubung, tapi penanda pairing gagal disimpan — sesi mungkin perlu di-scan ulang setelah restart.';
    }
  });

  client.on('ready', () => {
    if (sess.gen !== gen || sess.client !== client) return;
    clearReconnect(sess);
    sess.status = 'connected';
    sess.qrDataUrl = null;
    sess.qrExpiresAt = null;
    sess.pairingCode = null;
    sess.pairingCodeExpiresAt = null;
    sess.pairingPhone = null;
    sess.lastError = null;
    const wid = client.info?.wid;
    sess.userInfo = {
      // wid.user = digit nomor (tanpa "@c.us"); wid._serialized = "<digit>@c.us".
      number: wid?.user ? String(wid.user) : null,
      name: client.info?.pushname ?? null,
    };
    console.log(`[wa:${sess.id}] terhubung sebagai`, sess.userInfo.name, sess.userInfo.number);
  });

  client.on('auth_failure', async (message) => {
    if (sess.gen !== gen || sess.client !== client) return;
    console.error(`[wa:${sess.id}] auth_failure:`, message);
    sess.status = 'auth_failure';
    sess.lastError = 'Sesi tidak valid — klik "Request QR baru" untuk scan ulang.';
    sess.stopReconnect = true;
    clearReconnect(sess);
    sess.client = null;
    sess.pairingCode = null;
    sess.pairingCodeExpiresAt = null;
    // Tunggu Chromium BENAR-BENAR tutup sebelum profil dihapus. Kalau rmSync jalan
    // saat browser masih hidup, Chromium menulis ulang sebagian profil ketika
    // shutdown → tersisa profil setengah jadi + lock file yang membuat start()
    // berikutnya gagal launch.
    await client.destroy().catch(() => {});
    cleanupCreds(sess);
  });

  client.on('disconnected', async (reason) => {
    if (sess.gen !== gen || sess.client !== client) return;
    console.log(`[wa:${sess.id}] terputus:`, reason);
    sess.userInfo = null;
    sess.qrDataUrl = null;
    sess.qrExpiresAt = null;
    sess.pairingCode = null;
    sess.pairingCodeExpiresAt = null;
    sess.client = null;

    // Logout eksplisit dari perangkat tertaut → sesi invalid, butuh scan ulang.
    // destroy() DI-AWAIT dulu supaya profil tidak dihapus saat Chromium masih hidup.
    if (reason === 'LOGOUT') {
      sess.status = 'auth_failure';
      sess.lastError = 'Sesi di-logout dari WhatsApp';
      sess.stopReconnect = true;
      clearReconnect(sess);
      await client.destroy().catch(() => {});
      cleanupCreds(sess);
      return;
    }

    // Selain LOGOUT profil tidak dihapus, jadi destroy cukup fire-and-forget —
    // yang penting Chromium tidak bocor & tidak mengunci user-data-dir.
    client.destroy().catch(() => {});

    // Session dibuka instance/browser lain (setara 440 connectionReplaced Baileys).
    // JANGAN auto-reconnect — perang ping-pong tanpa akhir memperebutkan sesi.
    // Kredensial MASIH VALID → serahkan take-over ke aksi eksplisit user
    // ("Hubungkan" → rescan), meniru tombol "use here" WhatsApp Web.
    if (reason === 'CONFLICT') {
      sess.status = 'disconnected';
      sess.lastError = 'Sesi dibuka oleh instance lain — klik "Hubungkan" untuk mengambil alih.';
      sess.stopReconnect = true;
      clearReconnect(sess);
      return;
    }

    // Transient (TIMEOUT, page close, dll.): sesi yang sudah punya kredensial
    // valid auto-reconnect. Belum pernah ter-pair → kembali ke uninitialized
    // (QR tak otomatis muncul — user klik "Mulai" bila mau scan).
    const established = hasCreds(sess.id);
    sess.status = established ? 'disconnected' : 'uninitialized';
    sess.lastError = established
      ? 'Koneksi terputus — mencoba menyambung ulang…'
      : 'Belum terhubung — klik "Mulai / Scan QR" untuk pairing.';
    if (established) scheduleReconnect(sess);
  });
}

/**
 * Tunggu sebuah promise settle, maksimal `ms`. Kembalikan true bila benar-benar
 * settle, false bila keburu timeout — pemanggil WAJIB membedakannya (lihat rescan).
 *
 * Dipakai untuk menunggu start() yang masih in-flight: normalnya ia langsung
 * reject begitu browser di-destroy, tapi kita tidak mau request HTTP menggantung
 * selamanya kalau puppeteer tersangkut (authTimeoutMs default library = 0).
 */
function settleWithin(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([promise.then(() => true, () => true), timeout]).finally(() => {
    // Tanpa clearTimeout, timer 20 detik menahan event loop tetap hidup dan
    // memperlambat exit bersih saat SIGTERM/destroyAll.
    if (timer) clearTimeout(timer);
  });
}

/** Hapus profil LocalAuth sesi (kredensial basi) — dipakai auth_failure & rescan/logout. */
function cleanupCreds(sess) {
  try {
    fs.rmSync(sess.authDir, { recursive: true, force: true });
  } catch (_) {
    // abaikan
  }
}

/* ---------------- start / stop per-sesi ---------------- */

/**
 * Start (atau restart) koneksi whatsapp-web.js untuk satu sesi. Fire-and-forget
 * dari boot — status 'qr'/'connected' muncul async via event.
 * `sess.gen` guard: destroy/rescan/delete menaikkan gen → start() in-flight yang
 * sudah melewati await apa pun dibatalkan (client basi di-destroy).
 */
async function start(id) {
  const sess = registry.get(id);
  if (!sess) return null;
  if (sess.starting) return sess.starting;

  const gen = sess.gen;
  const promise = (async () => {
    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: config.authDir, clientId: id }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
      // Bila sesi diminta pairing lewat kode, library mendaftarkan event 'code'
      // (bukan 'qr') dan otomatis meminta kode ke WhatsApp saat initialize.
      ...(sess.pairingPhone
        ? {
            pairWithPhoneNumber: {
              phoneNumber: sess.pairingPhone,
              showNotification: true,
              intervalMs: PAIRING_CODE_INTERVAL_MS,
            },
          }
        : {}),
    });

    if (sess.gen !== gen) {
      await client.destroy().catch(() => {});
      return; // sesi dihapus/di-rescan saat client dibuat
    }

    sess.client = client;
    sess.status = 'connecting';
    sess.lastError = null;
    wireClientEvents(sess, client, gen);

    try {
      await client.initialize();
      // Gen bisa berubah SELAMA initialize (rescan/hapus sesi). Tanpa cek ini,
      // browser yang barusan sukses dibuka tidak dimiliki siapa pun: destroy()
      // sudah men-null-kan sess.client sebelum kita sampai sini, jadi tak ada
      // lagi yang akan menutupnya — Chromium menggantung sambil memegang lock
      // profil sehingga launch berikutnya bisa gagal.
      if (sess.gen !== gen) {
        await client.destroy().catch(() => {});
        return;
      }
    } catch (err) {
      if (sess.gen !== gen) {
        // Sama seperti di atas: lepas client sebelum keluar. Umumnya destroy()
        // sudah menutupnya (karena itu initialize reject), tapi pada race sempit
        // di mana destroy() belum sempat melihat sess.client, client ini masih hidup.
        await client.destroy().catch(() => {});
        return;
      }
      console.error(`[wa:${sess.id}] initialize gagal:`, err.message);
      // Putus referensi dulu, lalu destroy client agar Chromium tak bocor.
      sess.client = null;
      client.destroy().catch(() => {});
      // Event auth_failure biasanya sudah set status sebelum reject. Fallback untuk
      // reject TANPA event auth_failure (mis. Chromium gagal launch / jaringan
      // transient): ini BUKAN sesi invalid → jangan labeli auth_failure ("scan
      // ulang"). Retry reconnect dengan backoff.
      //
      // 'qr'/'pairing_code' WAJIB ikut: library memancarkan qr/code dari dalam
      // inject(), yaitu SEBELUM initialize() selesai. Bila langkah setelahnya
      // reject (mis. halaman navigasi saat QR discan), tanpa cabang ini status
      // tersangkut di 'qr' dengan client null → QR mati terus tampil selamanya
      // dan reconnect tak pernah dijadwalkan.
      if (['connecting', 'qr', 'pairing_code'].includes(sess.status)) {
        sess.qrDataUrl = null;
        sess.pairingCode = null;
        sess.pairingCodeExpiresAt = null;
        if (sess.pairingPhone) {
          // Mode kode pairing TIDAK boleh auto-reconnect: tiap percobaan ulang
          // membangun Client dalam mode pairing lagi dan menembakkan permintaan
          // kode baru (showNotification: true) ke nomor asli user — berulang tanpa
          // henti. Kembalikan ke jalur manual.
          sess.pairingPhone = null;
          sess.status = 'uninitialized';
          sess.lastError =
            'Gagal meminta kode pairing — coba lagi, atau pakai QR. ' + (err.message || '');
        } else {
          sess.status = 'disconnected';
          sess.lastError = err.message || 'Gagal inisialisasi WhatsApp Web';
          scheduleReconnect(sess);
        }
      }
    }
  })().finally(() => {
    if (sess.starting === promise) sess.starting = null;
  });

  sess.starting = promise;
  return promise;
}

/** Hentikan client satu sesi tanpa hapus row/folder (dipakai rescan, shutdown). */
async function destroy(id) {
  const sess = registry.get(id);
  if (!sess) return;
  sess.gen += 1; // batalkan start() yang sedang berjalan
  sess.stopReconnect = true;
  clearReconnect(sess);
  const client = sess.client;
  sess.client = null;
  sess.status = 'uninitialized';
  sess.qrDataUrl = null;
  sess.qrExpiresAt = null;
  sess.pairingCode = null;
  sess.pairingCodeExpiresAt = null;
  // pairingPhone sengaja TIDAK di-reset di sini: requestPairingCode memanggil
  // destroy() di tengah alurnya. rescan/logout yang mengembalikannya ke jalur QR.
  sess.userInfo = null;
  sess.lastError = null;
  if (client) {
    // client.destroy() pada puppeteer yang tersangkut tidak punya timeout sendiri —
    // batasi supaya handler HTTP (rescan / pairing-code) tidak ikut menggantung.
    await settleWithin(client.destroy(), DESTROY_TIMEOUT_MS);
  }
}

/* ---------------- manajemen sesi ---------------- */

/** Boot: start semua sesi yang punya kredensial. Sesi tanpa kredensial tetap tampil (nonaktif). */
function startAll() {
  ensureAuthDir();
  for (const s of sessionRepository.findAllUnscoped()) {
    if (!hasCreds(s.id)) continue; // tanpa kredensial → tidak di-start (anti-QR otomatis)
    const sess = registry.get(s.id) || createSession(s.id, s.name);
    registry.set(s.id, sess);
    start(s.id).catch((err) => {
      console.error(`[wa:${s.id}] start gagal:`, err.message);
    });
  }
}

/** Tambah sesi baru → auto-start (muncul QR bila belum ter-pair). */
function addSession(name, orgId) {
  ensureAuthDir();
  const id = generateUniqueSlug(name);
  sessionRepository.create({ id, name, orgId });
  const sess = createSession(id, name);
  registry.set(id, sess);
  start(id).catch((err) => {
    console.error(`[wa:${id}] start gagal:`, err.message);
  });
  return getStatus(id);
}

function renameSession(id, name, orgId) {
  assertOwned(id, orgId);
  sessionRepository.updateName(id, name, orgId);
  const sess = registry.get(id);
  if (sess) sess.name = name;
  return getStatus(id);
}

/**
 * Hapus sesi total: row + folder auth + client. Controller WAJIB men-cancel
 * broadcast yang memakai sesi ini SEBELUM memanggil deleteSession (lihat sessionController).
 */
async function deleteSession(id, orgId) {
  assertOwned(id, orgId);
  const sess = registry.get(id);
  if (sess) {
    sess.gen += 1;
    sess.stopReconnect = true;
    clearReconnect(sess);
    const client = sess.client;
    sess.client = null;
    if (client) {
      try {
        await client.destroy();
      } catch (_) {
        // abaikan
      }
    }
    registry.delete(id);
  }
  cleanupCreds({ authDir: path.join(config.authDir, `session-${id}`) });
  sessionRepository.remove(id, orgId);
}

/**
 * Hentikan + buat ulang client satu sesi. "Request QR baru" = pairing baru →
 * buang kredensial basi. Basis keputusan harus penanda di disk (hasCreds),
 * bukan state runtime: flag runtime selalu false setelah boot sampai event
 * 'ready' pertama — klik "Hubungkan" pasca-restart tak boleh menghapus
 * kredensial sesi yang masih valid.
 */
async function rescan(id, orgId) {
  assertOwned(id, orgId);
  let sess = registry.get(id);
  if (!sess) {
    const row = sessionRepository.findByIdUnscoped(id);
    sess = createSession(id, row.name);
    registry.set(id, sess);
  }
  const wasAuthFailure = sess.status === 'auth_failure'; // destroy me-reset status
  sess.pairingPhone = null; // rescan = kembali ke jalur QR
  sess.stopReconnect = true; // cegah timer lama menembak selama destroy
  await destroy(id);
  // WAJIB: tunggu start() yang mungkin masih berjalan sampai selesai. Dengan
  // whatsapp-web.js, initialize() menggantung 10–30 detik (launch Chromium + load
  // web.whatsapp.com). Kalau tidak ditunggu, start() di bawah hanya mengembalikan
  // promise LAMA (guard `if (sess.starting)`) yang lalu batal sendiri karena gen
  // sudah berubah → tidak ada client baru, tidak ada QR, dan tidak ada reconnect:
  // sesi diam di 'uninitialized' padahal API sudah membalas ok.
  let settled = true;
  if (sess.starting) settled = await settleWithin(sess.starting, START_SETTLE_TIMEOUT_MS);
  if (!settled) {
    // Timeout: start() lama belum selesai, jadi kita TIDAK tahu apakah masih ada
    // Chromium yang memegang profil ini. Melanjutkan sama saja merusak: menghapus
    // profil bisa mengorupsinya, dan melaunch Client baru di user-data-dir yang
    // sama akan gagal karena SingletonLock lalu terjerat loop reconnect.
    // Berhenti dengan pesan jelas — user tinggal mencoba lagi beberapa detik lagi.
    console.warn(`[wa:${id}] start sebelumnya belum selesai dalam ${START_SETTLE_TIMEOUT_MS}ms — rescan dibatalkan.`);
    sess.stopReconnect = false;
    throw new HttpError(
      409,
      'Sesi sedang dalam proses membuka koneksi — tunggu beberapa detik lalu coba lagi.'
    );
  }
  if (wasAuthFailure || !hasCreds(id)) {
    clearReconnect(sess);
    cleanupCreds(sess);
  }
  sess.stopReconnect = false;
  // Fire-and-forget, sama seperti addSession: client.initialize() butuh 30–40
  // detik (launch Chromium + load web.whatsapp.com + inject). Menunggunya di sini
  // membuat request HTTP menggantung sampai lewat batas timeout klien, padahal
  // status 'qr'/'connected' toh diambil frontend lewat polling.
  start(id).catch((err) => {
    console.error(`[wa:${id}] start gagal setelah rescan:`, err.message);
  });
}

/**
 * Normalisasi nomor untuk pairing code: WhatsApp mewajibkan format internasional
 * tanpa "+" (E.164 digit-only, 8–15 digit, tidak diawali 0).
 */
function normalizePairingPhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!/^[1-9]\d{7,14}$/.test(digits)) {
    throw new HttpError(
      400,
      'Nomor HP tidak valid — pakai format internasional tanpa "+" atau angka 0 di depan (mis. 6281234567890)'
    );
  }
  return digits;
}

/**
 * Pairing lewat kode 8 karakter (alternatif scan QR). whatsapp-web.js mendukung
 * ini via opsi `pairWithPhoneNumber` + event 'code'; kode muncul async di status
 * sesi (dipoll UI). Hanya untuk sesi TANPA pairing valid — sesi yang sudah
 * ter-pair memakai "Hubungkan" (rescan me-resume kredensial), karena membuang
 * kredensial sah demi pairing baru akan melepas linked device yang masih hidup.
 */
async function requestPairingCode(id, phone, orgId) {
  assertOwned(id, orgId);
  const normalized = normalizePairingPhone(phone);
  let sess = registry.get(id);
  if (!sess) {
    const row = sessionRepository.findByIdUnscoped(id);
    sess = createSession(id, row.name);
    registry.set(id, sess);
  }
  if (sess.status === 'connected') {
    throw new HttpError(409, 'Sesi sudah terhubung — logout dulu bila ingin pairing ulang.');
  }
  if (hasCreds(id)) {
    throw new HttpError(
      409,
      'Sesi masih punya pairing valid — klik "Hubungkan", atau logout/hapus dulu untuk pairing baru.'
    );
  }
  sess.stopReconnect = true;
  await destroy(id);
  let settled = true;
  if (sess.starting) settled = await settleWithin(sess.starting, START_SETTLE_TIMEOUT_MS);
  if (!settled) {
    // Sama seperti rescan: state profil tidak pasti, jadi jangan dihapus DAN
    // jangan dipakai ulang untuk launch baru.
    console.warn(`[wa:${id}] start sebelumnya belum selesai dalam ${START_SETTLE_TIMEOUT_MS}ms — permintaan kode dibatalkan.`);
    sess.stopReconnect = false;
    throw new HttpError(
      409,
      'Sesi sedang dalam proses membuka koneksi — tunggu beberapa detik lalu coba lagi.'
    );
  }
  clearReconnect(sess);
  cleanupCreds(sess); // sisa pairing gagal tak layak di-resume
  sess.pairingPhone = normalized; // penanda jalur kode — dibaca saat membuat Client
  sess.pairingCode = null;
  sess.pairingCodeExpiresAt = null;
  sess.stopReconnect = false;
  // Fire-and-forget (lihat catatan di rescan): kode pairing muncul async lewat
  // event 'code' dan diambil frontend dari polling status.
  start(id).catch((err) => {
    console.error(`[wa:${id}] start gagal setelah request kode pairing:`, err.message);
  });
  return getStatus(id);
}

/** Logout penuh satu sesi: invalidasi di server WhatsApp + hapus kredensial; row sesi tetap. */
async function logoutSession(id, orgId) {
  assertOwned(id, orgId); // sekaligus memastikan sesinya ada
  const sess = registry.get(id);
  if (sess) {
    sess.gen += 1;
    sess.stopReconnect = true;
    clearReconnect(sess);
    const client = sess.client;
    sess.client = null;
    if (client) {
      try {
        await client.logout(); // invalidasi sesi di server WhatsApp
      } catch (_) {
        // abaikan
      }
      try {
        await client.destroy();
      } catch (_) {
        // abaikan
      }
    }
    sess.status = 'uninitialized';
    sess.qrDataUrl = null;
    sess.qrExpiresAt = null;
    sess.pairingPhone = null;
    sess.pairingCode = null;
    sess.pairingCodeExpiresAt = null;
    sess.userInfo = null;
    sess.lastError = null;
  }
  cleanupCreds({ authDir: path.join(config.authDir, `session-${id}`) });
}

async function destroyAll() {
  await Promise.all([...registry.keys()].map((id) => destroy(id)));
}

/* ---------------- status / read ---------------- */

/** Status runtime satu sesi. Otorisasi dilakukan pemanggil (assertOwned). */
function getStatus(id) {
  const row = sessionRepository.findByIdUnscoped(id);
  if (!row) return null;
  const sess = registry.get(id);
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    hasCreds: hasCreds(id),
    status: sess?.status ?? 'uninitialized',
    connected: sess?.status === 'connected' && !!sess?.client,
    hasQr: sess?.status === 'qr' && !!sess?.qrDataUrl,
    qrDataUrl: sess?.qrDataUrl ?? null,
    qrExpiresAt: sess?.qrExpiresAt ?? null,
    hasPairingCode: sess?.status === 'pairing_code' && !!sess?.pairingCode,
    pairingCode: sess?.pairingCode ?? null,
    pairingCodeExpiresAt: sess?.pairingCodeExpiresAt ?? null,
    userInfo: sess?.userInfo ?? null,
    lastError: sess?.lastError ?? null,
  };
}

function listSessions(orgId) {
  return sessionRepository.findAll(orgId).map((r) => getStatus(r.id));
}

function isConnected(id) {
  const sess = registry.get(id);
  return !!(sess && sess.status === 'connected' && sess.client);
}

/**
 * Kirim pesan ke sebuah chatId (format whatsapp-web.js: `<number>@c.us` / `<gid>@g.us`).
 * content: { text?, mediaPath? } — bila mediaPath ada, text jadi caption.
 * Teks ber-URL → preview link di-generate native oleh WhatsApp Web.
 */
async function sendMessage(id, chatId, { text, mediaPath }) {
  const sess = registry.get(id);
  if (!sess) throw new Error(`Sesi "${id}" tidak ditemukan`);
  if (sess.status !== 'connected' || !sess.client) {
    throw new Error(`WhatsApp sesi "${sess.name || id}" belum terhubung`);
  }

  if (mediaPath) {
    // media tersimpan relatif terhadap uploadDir, bukan root project.
    const abs = path.resolve(config.uploadDir, mediaPath);
    const media = MessageMedia.fromFilePath(abs); // ENOENT → throw → recipient failed
    await sess.client.sendMessage(chatId, media, {
      caption: text && text.trim() ? text : undefined,
    });
  } else {
    await sess.client.sendMessage(chatId, text ?? '');
  }
}

module.exports = {
  start,
  startAll,
  destroy,
  destroyAll,
  addSession,
  renameSession,
  deleteSession,
  getStatus,
  listSessions,
  sessionExists,
  assertOwned,
  hasCreds,
  isConnected,
  sendMessage,
  rescan,
  requestPairingCode,
  logoutSession,
};
