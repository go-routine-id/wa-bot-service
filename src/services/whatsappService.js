'use strict';

const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const QRCode = require('qrcode');
const config = require('../../config');
const sessionRepository = require('../repositories/sessionRepository');
const { HttpError } = require('../utils/httpError');

const RECONNECT_DELAYS = [3000, 5000, 10000, 20000, 30000]; // ms; cap 30s, ulang terus
// Backstop validitas QR. Praktisnya Baileys merotasi QR (60s pertama, lalu tiap
// 20s — lib/Socket/socket.js rc14) dan timer ini di-reset tiap QR baru, jadi
// hampir tak pernah menembak; batas pairing sesungguhnya = ref QR dari server
// habis (close 408) + cap retry di bawah. Timer ini jaga-jaga bila rotasi QR
// berhenti tanpa event close.
const QR_TTL_MS = 60000;
// Retry otomatis TERBATAS saat blip transient (515/408/428) di fase pairing: QR
// dibuat ulang maks MAX_PAIR_RETRIES kali, lalu menyerah ke tombol manual.
// Bukan loop tak terbatas → risiko banned tetap dibatasi (hanya beberapa identity
// per aksi user, bukan reconnect tanpa henti seperti anti-loop task #28).
const MAX_PAIR_RETRIES = 2;
// Jeda retry otomatis fase pairing (backoff per percobaan): 515/408 cenderung
// persisten puluhan detik — retry 3 detik flat hampir selalu sia-sia (kasus
// pairing 'bisnis').
const PAIR_RETRY_DELAYS = [5000, 15000];
// Jendela validitas kode pairing 8 digit. Lebih panjang dari QR karena kode
// diketik manual di HP (bukan race kamera) — 3 menit cukup santai tapi tetap
// membatasi exposure kode yang tampil di UI.
const PAIRING_CODE_TTL_MS = 3 * 60 * 1000;

/**
 * Registry sesi runtime. Sumber kebenaran keberadaan sesi = tabel `sessions`;
 * Map ini hanya state socket/status/QR per sesi.
 * Map<sessionId, SessionState>
 */
const registry = new Map();

// Baileys v7 ESM-only; proyek CJS → dimuat via import() dinamis (di-memoize agar
// dua sesi yang start bersamaan tidak dobel-import).
let baileys = null;
let pino = null;

/* ---------------- helpers ---------------- */

async function loadBaileys() {
  if (!baileys) baileys = await import('@whiskeysockets/baileys');
  if (!pino) pino = (await import('pino')).default;
  return baileys;
}

function quietLogger() {
  return pino({ level: 'warn' });
}

function ensureAuthDir() {
  fs.mkdirSync(config.authDir, { recursive: true });
}

/**
 * Apakah sesi punya pairing WhatsApp yang valid & bisa di-resume?
 * creds.json saja TIDAK cukup: Baileys menulis creds.json (identity setengah
 * jadi) begitu QR dibuat — sesi yang pairing-nya gagal/aborted hanya punya file
 * itu (field `registered` TIDAK bisa dipakai: linked device hasil scan QR tetap
 * registered:false). Sesi yang pernah berhasil terkoneksi ditandai file
 * `.linked` (ditulis saat connection open) atau punya state tambahan
 * (app-state-sync-*, session-*, device-list-*, identity-key-*, dll.).
 */
function hasCreds(id) {
  const dir = path.join(config.authDir, id);
  if (!fs.existsSync(path.join(dir, 'creds.json'))) return false;
  try {
    if (fs.existsSync(path.join(dir, '.linked'))) return true;
    // Backfill sesi valid yang dibuat sebelum marker ada: state Baileys lain
    // selain creds.json hanya muncul setelah pairing sukses & sesi berjalan.
    return fs.readdirSync(dir).filter((f) => f !== 'creds.json').length > 0;
  } catch (_) {
    return false; // folder tak terbaca → anggap tidak ada creds
  }
}

function sessionExists(id) {
  return !!sessionRepository.findById(id);
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

/**
 * Slug unik terhadap tabel sessions + folder auth (backstop saat crash/partial).
 * Insert DB sinkron (better-sqlite3) → dua request tak bisa interleave di sini.
 */
function generateUniqueSlug(name) {
  const base = slugify(name);
  let id = base;
  let n = 2;
  while (sessionRepository.findById(id) || fs.existsSync(path.join(config.authDir, id))) {
    id = `${base}-${n++}`;
  }
  return id;
}

function createSession(id, name) {
  return {
    id,
    name,
    authDir: path.join(config.authDir, id),
    // uninitialized | connecting | qr | pairing_code | connected | disconnected | auth_failure | qr_expired
    status: 'uninitialized',
    qrDataUrl: null,
    qrExpiresAt: null,
    pairingCode: null, // kode 8 digit dari requestPairingCode (null bila jalur QR)
    pairingCodeExpiresAt: null,
    pairingPhone: null, // nomor tujuan jalur kode pairing; null = jalur QR biasa
    pairingRequested: false, // guard: kode hanya diminta sekali per lifecycle socket
    pairExpiryTimer: null, // timer: kode pairing tak dipakai → qr_expired
    userInfo: null,
    lastError: null,
    sock: null, // socket Baileys (makeWASocket) yang aktif
    starting: null, // promise start() berjalan (cegah race membuat 2 socket per sesi)
    reconnectTimer: null, // timer auto-reconnect backoff
    qrExpiryTimer: null, // timer: QR tak ter-scan & tak di-refresh → qr_expired
    reconnectAttempts: 0,
    stopReconnect: false, // true saat destroy/logout/delete; false saat rescan/start ulang
    wasConnected: false, // socket lifecycle ini pernah 'connected'? → kunci blip recovery
    gen: 0, // naik tiap destroy/rescan/delete → start() in-flight dibatalkan (fix race)
    pairRetries: 0, // retry otomatis yang sudah dipakai di fase pairing (cap MAX_PAIR_RETRIES)
    pairRetryTimer: null, // timer retry otomatis saat blip transient di fase QR
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

function clearQrExpiry(sess) {
  if (sess.qrExpiryTimer) {
    clearTimeout(sess.qrExpiryTimer);
    sess.qrExpiryTimer = null;
  }
}

/** Batalkan timer retry otomatis pairing (dipanggil saat lifecycle pindah fase). */
function clearPairRetry(sess) {
  if (sess.pairRetryTimer) {
    clearTimeout(sess.pairRetryTimer);
    sess.pairRetryTimer = null;
  }
}

function clearPairExpiry(sess) {
  if (sess.pairExpiryTimer) {
    clearTimeout(sess.pairExpiryTimer);
    sess.pairExpiryTimer = null;
  }
}

/**
 * Jendela validitas kode pairing: tak dipakai dalam PAIRING_CODE_TTL_MS →
 * qr_expired (state expired dipakai bersama jalur QR; lastError menjelaskan
 * konteksnya kode pairing) + hentikan socket. Kode baru hanya via request manual.
 */
function schedulePairExpiry(sess) {
  clearPairExpiry(sess);
  sess.pairExpiryTimer = setTimeout(() => {
    sess.pairExpiryTimer = null;
    if (sess.status !== 'pairing_code') return; // sudah ter-pair / state berubah → abaikan
    const sock = sess.sock;
    console.log(`[wa:${sess.id}] kode pairing kedaluwarsa (tidak dipakai) — pairing dihentikan, tunggu request manual.`);
    sess.status = 'qr_expired';
    sess.pairingCode = null;
    sess.pairingCodeExpiresAt = null;
    sess.lastError = 'Kode pairing kedaluwarsa — minta kode baru atau pakai QR.';
    sess.sock = null;
    sess.wasConnected = false;
    if (sock) {
      try {
        sock.end();
      } catch (_) {
        // abaikan — socket mungkin sudah mati
      }
    }
  }, PAIRING_CODE_TTL_MS);
}

/**
 * Jendela validitas QR: bila tak ter-scan dan tak di-refresh Baileys dalam
 * QR_TTL_MS → pindah ke qr_expired + hentikan socket. QR TIDAK tampil lagi,
 * hanya tombol manual. QR baru hanya muncul saat user request ulang.
 */
function scheduleQrExpiry(sess) {
  clearQrExpiry(sess);
  sess.qrExpiryTimer = setTimeout(() => {
    sess.qrExpiryTimer = null;
    if (sess.status !== 'qr') return; // sudah discan / state berubah → abaikan
    const sock = sess.sock;
    console.log(`[wa:${sess.id}] QR kedaluwarsa (tidak discan) — pairing dihentikan, tunggu request manual.`);
    sess.status = 'qr_expired';
    sess.qrDataUrl = null;
    sess.qrExpiresAt = null;
    sess.lastError = 'QR kedaluwarsa — klik "Request QR baru" untuk membuat QR baru.';
    sess.sock = null;
    sess.wasConnected = false;
    if (sock) {
      try {
        sock.end();
      } catch (_) {
        // abaikan — socket mungkin sudah mati
      }
    }
  }, QR_TTL_MS);
}

function scheduleReconnect(sess) {
  if (sess.stopReconnect || sess.reconnectTimer) return;
  const delay = RECONNECT_DELAYS[Math.min(sess.reconnectAttempts, RECONNECT_DELAYS.length - 1)];
  sess.reconnectAttempts += 1;
  sess.reconnectTimer = setTimeout(() => {
    sess.reconnectTimer = null;
    if (sess.stopReconnect) return;
    console.log(`[wa:${sess.id}] mencoba koneksi ulang…`);
    start(sess.id).catch((err) => {
      console.error(`[wa:${sess.id}] reconnect gagal:`, err.message);
      // start() yang throw SEBELUM socket terbuat tidak memancarkan close event
      // → tanpa reschedule, sesi macet di 'disconnected' selamanya (D2).
      // Lanjutkan backoff; error permanen tetap terlihat di log tiap siklus.
      scheduleReconnect(sess);
    });
  }, delay);
}

/* ---------------- event socket per-sesi ---------------- */

/**
 * Terjemahkan sinyal Baileys (connection.update) ke status aplikasi.
 * `sock` adalah socket tempat event berasal — event dari socket lama (usai
 * rescan/delete) diabaikan via pengecekan `sess.sock !== sock`.
 */
async function handleConnectionUpdate(sess, sock, update) {
  if (sess.sock !== sock) return;

  // Belum ter-pair → Baileys mengirim QR baru (berputar ~30 detik).
  // Corner D3 (didokumentasikan, sengaja tidak diubah): creds.json korup pada
  // sesi established juga mendarat di sini — readData Baileys menelan error
  // parse → identity fresh → QR. Self-healing: user scan → pairing ulang;
  // tak discan → 401 → auth_failure.
  if (update.qr) {
    // Jalur kode pairing: event qr pertama = socket sudah cukup jauh handshake
    // untuk meminta kode. QR-nya sendiri diabaikan (tidak ditampilkan).
    // Guard pairingRequested: Baileys merotasi event qr — kode hanya diminta
    // sekali per lifecycle socket (di-reset start() saat retry).
    if (sess.pairingPhone) {
      if (sess.pairingRequested) return;
      sess.pairingRequested = true;
      sock
        .requestPairingCode(sess.pairingPhone)
        .then((code) => {
          if (sess.sock !== sock) return; // socket diganti selama await (race B3)
          sess.status = 'pairing_code';
          sess.pairingCode = code;
          sess.pairingCodeExpiresAt = Date.now() + PAIRING_CODE_TTL_MS;
          sess.lastError = null;
          clearPairRetry(sess);
          schedulePairExpiry(sess);
          console.log(`[wa:${sess.id}] kode pairing dibuat:`, code);
        })
        .catch((err) => {
          if (sess.sock !== sock) return;
          console.error(`[wa:${sess.id}] gagal meminta kode pairing:`, err.message);
          sess.status = 'qr_expired';
          sess.pairingCode = null;
          sess.pairingCodeExpiresAt = null;
          sess.lastError = 'WhatsApp menolak permintaan kode pairing — coba lagi nanti, atau pakai QR.';
          const dead = sess.sock;
          sess.sock = null;
          if (dead) {
            try {
              dead.end();
            } catch (_) {
              // abaikan
            }
          }
        });
      return;
    }
    let dataUrl = null;
    try {
      dataUrl = await QRCode.toDataURL(update.qr);
    } catch (err) {
      console.error(`[wa:${sess.id}] gagal generate QR:`, err.message);
    }
    // toDataURL async: socket bisa sudah close/di-end selama await (515/408 atau
    // QR TTL habis). Tanpa re-check, QR basi "bangkit" menempel di state
    // qr_expired — teramati: GET /api/sessions → qr_expired tapi qrDataUrl
    // non-null (race B3).
    if (sess.sock !== sock) return;
    sess.status = 'qr';
    sess.qrDataUrl = dataUrl;
    sess.qrExpiresAt = Date.now() + QR_TTL_MS;
    clearPairRetry(sess); // QR baru sudah tampil → retry pending tak relevan lagi
    scheduleQrExpiry(sess); // reset jendela validitas tiap QR baru dari Baileys
    return;
  }

  if (update.connection === 'open') {
    clearReconnect(sess);
    clearQrExpiry(sess); // sudah terhubung, QR tak perlu lagi
    clearPairRetry(sess); // sudah terhubung → retry pairing tidak perlu lagi
    clearPairExpiry(sess);
    sess.pairingCode = null;
    sess.pairingCodeExpiresAt = null;
    sess.pairingPhone = null;
    sess.pairingRequested = false;
    sess.wasConnected = true; // lifecycle socket ini pernah terhubung → blip boleh auto-recover
    try {
      // Penanda pairing valid: dipakai hasCreds() membedakan sesi established vs
      // pairing gagal (yang hanya punya creds.json). Terhapus saat rescan/logout.
      fs.writeFileSync(path.join(sess.authDir, '.linked'), String(Date.now()));
    } catch (_) {
      // abaikan — marker bukan kritikal
    }
    const user = sock.user;
    sess.status = 'connected';
    sess.qrDataUrl = null;
    sess.qrExpiresAt = null;
    sess.lastError = null;
    sess.userInfo = {
      // creds.me.id berbentuk "628...:5@s.whatsapp.net" → ambil digit saja.
      number: user?.id ? String(user.id).split(':')[0].replace(/@.*$/, '') : null,
      name: user?.name ?? null,
    };
    console.log(`[wa:${sess.id}] terhubung sebagai`, sess.userInfo.name, sess.userInfo.number);
    return;
  }

  if (update.connection === 'close') {
    const statusCode = update.lastDisconnect?.error?.output?.statusCode;
    const reason =
      update.lastDisconnect?.error?.message ||
      update.lastDisconnect?.error?.output?.payload?.message ||
      'connection closed';
    console.log(`[wa:${sess.id}] koneksi ditutup (statusCode:`, statusCode + ')', reason);
    clearQrExpiry(sess);
    clearPairExpiry(sess);
    sess.userInfo = null;
    // pairingPhone sengaja TIDAK di-reset di sini: retry otomatis fase pairing
    // (cabang non-established di bawah) memakainya untuk meminta kode baru.
    sess.pairingCode = null;
    sess.pairingCodeExpiresAt = null;

    // Fatal & permanen: sesi invalid/di-logout → minta scan ulang, berhenti reconnect.
    if (
      statusCode === baileys.DisconnectReason.loggedOut ||
      statusCode === baileys.DisconnectReason.badSession
    ) {
      sess.status = 'auth_failure';
      sess.lastError =
        statusCode === baileys.DisconnectReason.loggedOut
          ? 'Sesi di-logout dari WhatsApp'
          : 'Sesi tidak valid (bad session)';
      sess.stopReconnect = true;
      clearReconnect(sess);
      sess.sock = null;
      return;
    }

    // 440 connectionReplaced: creds yang sama dibuka instance lain (proses kedua
    // berbagi .baileys_auth, creds hasil copy-an di mesin lain, PM2 cluster, dsb.).
    // JANGAN auto-reconnect — itu perang ping-pong tanpa akhir memperebutkan sesi,
    // dan tiap tendangan = handshake penuh ke server WA (menambah risiko throttle
    // 515). Creds MASIH VALID (bukan auth_failure — jangan hapus apa pun) →
    // berhenti & serahkan take-over ke aksi eksplisit user, meniru tombol
    // "use here" di WhatsApp Web ("Hubungkan" → rescan me-reset stopReconnect).
    if (statusCode === baileys.DisconnectReason.connectionReplaced) {
      sess.status = 'disconnected';
      sess.qrDataUrl = null;
      sess.qrExpiresAt = null;
      sess.lastError = 'Sesi dibuka oleh instance lain — klik "Hubungkan" untuk mengambil alih.';
      sess.stopReconnect = true;
      clearReconnect(sess);
      sess.sock = null;
      return;
    }

    // Transient (connectionClosed=428, connectionLost=408, dll.).
    // Established = pernah connected ATAU punya creds valid di disk. wasConnected
    // saja TIDAK cukup: start() me-reset-nya tiap socket baru, jadi reconnect yang
    // gagal handshake sebelum 'open' (408/515) salah masuk cabang pairing — sesi
    // established dipaksa "Request QR baru" padahal creds-nya valid (bug B4,
    // kejadian 29 Agu: utama 428 → reconnect → 408 → qr_expired). Prinsip sama
    // dengan fix B1: kebenaran ada di disk. Sesi established auto-reconnect pakai
    // creds tersimpan (tidak bikin pairing baru, aman); cabang QR murni untuk
    // sesi tanpa creds. Kalau belum pernah ter-pair → JANGAN auto-reconnect
    // tak terbatas: loop 408→QR baru = percobaan pairing berulang ke server
    // WhatsApp (risiko banned) → retry terbatas lalu tombol manual.
    const established = sess.wasConnected || hasCreds(sess.id);
    sess.status = established ? 'disconnected' : 'qr_expired';
    sess.qrDataUrl = null; // pastikan QR tak tampil di state expired
    sess.qrExpiresAt = null;
    sess.lastError = established
      ? reason
      : sess.pairingPhone
        ? 'Pairing via kode terputus — minta kode baru atau pakai QR.'
        : 'QR kedaluwarsa / pairing terputus otomatis — klik "Request QR baru" untuk membuat QR baru.';
    sess.sock = null;
    if (established) {
      scheduleReconnect(sess);
    } else {
      // Fase pairing (belum pernah connected) + blip transient: jangan menyerah
      // langsung. Retry otomatis TERBATAS (MAX_PAIR_RETRIES): start() buang creds
      // basi → identity baru + QR fresh → user dapat kesempatan scan ulang tanpa
      // klik ulang. Setelah quota habis → qr_expired manual (anti pairing-loop
      // dari task #28 tetap dijaga — tidak ada reconnect loop tak terbatas).
      clearReconnect(sess);
      if (sess.pairRetries < MAX_PAIR_RETRIES) {
        sess.pairRetries += 1;
        sess.status = 'qr_expired';
        sess.lastError = sess.pairingPhone
          ? `Koneksi terputus sementara saat pairing — meminta kode baru… (${sess.pairRetries}/${MAX_PAIR_RETRIES})`
          : `Koneksi terputus sementara saat pairing — membuat QR baru… (${sess.pairRetries}/${MAX_PAIR_RETRIES})`;
        sess.pairRetryTimer = setTimeout(() => {
          sess.pairRetryTimer = null;
          // User sudah request ulang / state berubah → jangan menembak retry basi.
          if (sess.status !== 'qr_expired' || sess.sock) return;
          console.log(`[wa:${sess.id}] retry otomatis pairing (${sess.pairRetries}/${MAX_PAIR_RETRIES}) — buat QR baru…`);
          start(sess.id).catch((err) => {
            console.error(`[wa:${sess.id}] retry pairing gagal:`, err.message);
          });
        }, PAIR_RETRY_DELAYS[Math.min(sess.pairRetries - 1, PAIR_RETRY_DELAYS.length - 1)]);
      } else {
        sess.lastError = sess.pairingPhone
          ? 'Pairing via kode terputus — minta kode baru atau pakai QR.'
          : 'QR kedaluwarsa / pairing terputus otomatis — klik "Request QR baru" untuk membuat QR baru.';
      }
    }
  }
}

/* ---------------- start / stop per-sesi ---------------- */

/**
 * Start (atau restart) koneksi Baileys untuk satu sesi. Fire-and-forget dari boot —
 * status 'qr' / 'connected' muncul async via event.
 * `sess.gen` guard: destroy/rescan/delete menaikkan gen → start() in-flight yang
 * sudah melewati await apa pun dibatalkan (socket basi di-end).
 */
async function start(id) {
  const sess = registry.get(id);
  if (!sess) return null;
  if (sess.starting) return sess.starting;

  // Jangan pernah resume creds pairing yang gagal/aborted: kalau creds.json ada
  // tapi sesi belum pernah punya pairing valid (hasCreds false = hanya creds.json,
  // tanpa state Baileys/.linked), buang dulu supaya start() menghasilkan QR baru,
  // bukan resume identity setengah jadi → 401 loggedOut / 515 berulang.
  if (fs.existsSync(path.join(sess.authDir, 'creds.json')) && !hasCreds(sess.id)) {
    try {
      fs.rmSync(sess.authDir, { recursive: true, force: true });
    } catch (_) {
      // abaikan
    }
  }

  const gen = sess.gen;
  const promise = (async () => {
    const lib = await loadBaileys();
    if (sess.gen !== gen) return; // destroy/rescan saat import berlangsung
    const { state: authState, saveCreds } = await lib.useMultiFileAuthState(sess.authDir);
    if (sess.gen !== gen) return;
    const sock = lib.makeWASocket({
      auth: authState,
      printQRInTerminal: false,
      logger: quietLogger(),
      // rc14 tidak punya auto-reconnect internal (opsi maxReconnectRetries sudah
      // tidak dibaca library — terverifikasi grep lib/ rc14) → semua keputusan
      // reconnect memang sepenuhnya di kode kita: scheduleReconnect untuk sesi
      // yang pernah connected, retry terbatas untuk fase pairing.
    });
    if (sess.gen !== gen) {
      try {
        sock.end();
      } catch (_) {}
      return; // sesi dihapus/di-rescan saat start berlangsung
    }
    sess.sock = sock;
    sess.wasConnected = false; // lifecycle socket baru dimulai belum pernah connected
    sess.pairingRequested = false; // lifecycle baru boleh meminta kode pairing lagi (retry)
    sess.status = 'connecting';
    sess.lastError = null;

    sock.ev.on('creds.update', () => {
      // saveCreds fire-and-forget: listener async tak di-await Baileys, dan
      // authDir bisa sudah terhapus (rescan/delete/logout) saat write jalan →
      // writeFile ENOENT → unhandledRejection → crash SELURUH proses (D1).
      // Telan errornya: kehilangan satu tulisan creds jauh lebih baik daripada
      // semua sesi ikut mati.
      saveCreds().catch(() => {});
    });
    sock.ev.on('connection.update', (update) => handleConnectionUpdate(sess, sock, update));
  })().finally(() => {
    if (sess.starting === promise) sess.starting = null;
  });

  sess.starting = promise;
  return promise;
}

/** Hentikan socket satu sesi tanpa hapus row/folder (dipakai rescan, logout, shutdown). */
async function destroy(id) {
  const sess = registry.get(id);
  if (!sess) return;
  sess.gen += 1; // batalkan start() yang sedang berjalan
  sess.stopReconnect = true;
  clearReconnect(sess);
  clearQrExpiry(sess);
  clearPairRetry(sess);
  clearPairExpiry(sess);
  sess.wasConnected = false;
  const sock = sess.sock;
  sess.sock = null;
  sess.status = 'uninitialized';
  sess.qrDataUrl = null;
  sess.qrExpiresAt = null;
  // pairingPhone/pairingRequested TIDAK di-reset di sini — destroy dipanggil di
  // tengah flow requestPairingCode; caller (rescan/logout) yang mereset jalur.
  sess.pairingCode = null;
  sess.pairingCodeExpiresAt = null;
  sess.userInfo = null;
  sess.lastError = null;
  if (sock) {
    try {
      await sock.end();
    } catch (_) {
      // abaikan — socket mungkin sudah mati
    }
  }
}

/* ---------------- manajemen sesi ---------------- */

/** Boot: start semua sesi yang punya creds. Sesi tanpa creds tetap tampil (nonaktif). */
function startAll() {
  ensureAuthDir();
  for (const s of sessionRepository.findAll()) {
    if (!hasCreds(s.id)) continue; // tanpa creds → tidak di-start (anti pairing-loop otomatis)
    const sess = registry.get(s.id) || createSession(s.id, s.name);
    registry.set(s.id, sess);
    start(s.id).catch((err) => {
      console.error(`[wa:${s.id}] start gagal:`, err.message);
    });
  }
}

/** Tambah sesi baru → auto-start (muncul QR bila belum ter-pair). */
function addSession(name) {
  ensureAuthDir();
  const id = generateUniqueSlug(name);
  sessionRepository.create({ id, name });
  const sess = createSession(id, name);
  registry.set(id, sess);
  start(id).catch((err) => {
    console.error(`[wa:${id}] start gagal:`, err.message);
  });
  return getStatus(id);
}

function renameSession(id, name) {
  if (!sessionExists(id)) throw new HttpError(404, 'Sesi tidak ditemukan');
  sessionRepository.updateName(id, name);
  const sess = registry.get(id);
  if (sess) sess.name = name;
  return getStatus(id);
}

/**
 * Hapus sesi total: row + folder auth + socket. Controller WAJIB men-cancel
 * broadcast yang memakai sesi ini SEBELUM memanggil deleteSession (lihat sessionController).
 */
async function deleteSession(id) {
  const sess = registry.get(id);
  if (sess) {
    sess.gen += 1;
    sess.stopReconnect = true;
    clearReconnect(sess);
    clearQrExpiry(sess);
    clearPairRetry(sess);
    clearPairExpiry(sess);
    const sock = sess.sock;
    sess.sock = null;
    if (sock) {
      try {
        await sock.end();
      } catch (_) {
        // abaikan
      }
    }
    registry.delete(id);
  }
  try {
    fs.rmSync(path.join(config.authDir, id), { recursive: true, force: true });
  } catch (_) {
    // abaikan
  }
  sessionRepository.remove(id);
}

/** Hentikan + buat ulang socket satu sesi. Setelah auth_failure, buang creds agar muncul QR baru. */
async function rescan(id) {
  if (!sessionExists(id)) throw new HttpError(404, 'Sesi tidak ditemukan');
  let sess = registry.get(id);
  if (!sess) {
    const row = sessionRepository.findById(id);
    sess = createSession(id, row.name);
    registry.set(id, sess);
  }
  // "Request QR baru" = pairing baru → buang creds basi. Bukan cuma saat
  // auth_failure: sisa pairing yang gagal (515, QR expired, connecting) juga tak
  // layak di-resume — kalau dibiarkan, start() resume identity setengah jadi →
  // 401 loggedOut / 515 berulang (loop gagal pairing). Sesi yang established
  // (hasCreds di disk) tetap resume creds valid, tidak dipaksa scan ulang.
  // Basis keputusan HARUS penanda di disk, bukan sess.wasConnected: flag runtime
  // itu selalu false setelah boot sampai connection open pertama — klik
  // "Hubungkan" pasca-restart dulu bisa menghapus creds sesi yang masih valid.
  const wasAuthFailure = sess.status === 'auth_failure'; // destroy me-reset status
  clearPairRetry(sess); // aksi user eksplisit → batalkan retry otomatis yang tertunda
  sess.pairRetries = 0; // ...dan isi ulang quota retry penuh
  sess.pairingPhone = null; // rescan = kembali ke jalur QR
  sess.pairingRequested = false;
  sess.stopReconnect = true; // cegah timer lama menembak selama destroy
  // Urutan WAJIB destroy → rm (D1): socket harus mati dulu supaya tidak ada
  // creds.update/keys.set yang menulis ke folder yang sedang dihapus.
  await destroy(id);
  if (wasAuthFailure || !hasCreds(id)) {
    clearReconnect(sess);
    try {
      fs.rmSync(sess.authDir, { recursive: true, force: true });
    } catch (_) {
      // abaikan
    }
  }
  sess.stopReconnect = false; // sesi baru boleh auto-reconnect setelah pernah connected
  await start(id);
}

/**
 * Normalisasi nomor untuk pairing code: WhatsApp mewajibkan format internasional
 * tanpa "+" (E.164 digit-only, 8-15 digit, tidak diawali 0).
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
 * Pairing via kode 8 digit (alternatif scan QR): restart socket bersih seperti
 * rescan, tandai jalur kode (sess.pairingPhone), lalu kode diminta ke WhatsApp
 * saat socket mulai handshake — di-intercept dari event qr pertama (lihat
 * handleConnectionUpdate). Kode muncul async di status sesi (polling UI).
 * Hanya untuk sesi TANPA pairing valid: sesi established memakai "Hubungkan"
 * (rescan me-resume creds) — menghapus creds valid demi pairing baru di sini
 * akan membuang linked device yang masih hidup.
 */
async function requestPairingCode(id, phone) {
  if (!sessionExists(id)) throw new HttpError(404, 'Sesi tidak ditemukan');
  const normalized = normalizePairingPhone(phone);
  let sess = registry.get(id);
  if (!sess) {
    const row = sessionRepository.findById(id);
    sess = createSession(id, row.name);
    registry.set(id, sess);
  }
  if (sess.status === 'connected') {
    throw new HttpError(409, 'Sesi sudah terhubung — logout dulu bila ingin pairing ulang.');
  }
  if (hasCreds(id)) {
    throw new HttpError(409, 'Sesi masih punya pairing valid — klik "Hubungkan", atau logout/hapus dulu untuk pairing baru.');
  }
  clearPairRetry(sess);
  sess.pairRetries = 0;
  sess.stopReconnect = true;
  // Urutan WAJIB destroy → rm (D1), sama seperti rescan: sisa pairing gagal tak
  // layak di-resume (identity setengah jadi → 401/515 berulang).
  await destroy(id);
  clearReconnect(sess);
  try {
    fs.rmSync(sess.authDir, { recursive: true, force: true });
  } catch (_) {
    // abaikan
  }
  sess.pairingPhone = normalized; // penanda jalur kode — di-intercept di handleConnectionUpdate
  sess.pairingRequested = false;
  sess.pairingCode = null;
  sess.pairingCodeExpiresAt = null;
  sess.stopReconnect = false;
  await start(id);
  return getStatus(id);
}

/** Logout penuh satu sesi: invalidasi di server WhatsApp + hapus creds; row sesi tetap (bisa scan ulang). */
async function logoutSession(id) {
  if (!sessionExists(id)) throw new HttpError(404, 'Sesi tidak ditemukan');
  const sess = registry.get(id);
  if (sess) {
    sess.gen += 1;
    sess.stopReconnect = true;
    clearReconnect(sess);
    clearQrExpiry(sess);
    clearPairRetry(sess);
    clearPairExpiry(sess);
    sess.wasConnected = false;
    sess.pairingPhone = null;
    sess.pairingRequested = false;
    const sock = sess.sock;
    sess.sock = null;
    if (sock) {
      try {
        await sock.logout(); // invalidasi sesi di server WhatsApp
      } catch (_) {
        // abaikan
      }
      try {
        await sock.end();
      } catch (_) {
        // abaikan
      }
    }
    sess.status = 'uninitialized';
    sess.qrDataUrl = null;
    sess.qrExpiresAt = null;
    sess.userInfo = null;
    sess.lastError = null;
  }
  try {
    fs.rmSync(path.join(config.authDir, id), { recursive: true, force: true });
  } catch (_) {
    // abaikan
  }
}

async function destroyAll() {
  await Promise.all([...registry.keys()].map((id) => destroy(id)));
}

/* ---------------- status / read ---------------- */

function getStatus(id) {
  const row = sessionRepository.findById(id);
  if (!row) return null;
  const sess = registry.get(id);
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    hasCreds: hasCreds(id),
    status: sess?.status ?? 'uninitialized',
    connected: sess?.status === 'connected' && !!sess?.sock,
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

function listSessions() {
  return sessionRepository.findAll().map((r) => getStatus(r.id));
}

function isConnected(id) {
  const sess = registry.get(id);
  return !!(sess && sess.status === 'connected' && sess.sock);
}

/**
 * Kirim pesan ke sebuah chatId (JID Baileys) dari sesi tertentu.
 * content: { text?, mediaPath?, } — bila mediaPath ada, text jadi caption.
 * Error spesifik per-sesi agar runner bisa menerjemahkan jadi failed yang jelas.
 */
async function sendMessage(id, chatId, { text, mediaPath }) {
  const sess = registry.get(id);
  if (!sess) throw new Error(`Sesi "${id}" tidak ditemukan`);
  if (sess.status !== 'connected' || !sess.sock) {
    throw new Error(`WhatsApp sesi "${sess.name || id}" belum terhubung`);
  }

  if (mediaPath) {
    // media tersimpan relatif terhadap uploadDir, bukan root project.
    const abs = path.resolve(config.uploadDir, mediaPath);
    const buffer = fs.readFileSync(abs); // ENOENT → throw → recipient ditandai failed
    const mimetype = mime.lookup(abs) || 'image/*';
    await sess.sock.sendMessage(chatId, {
      image: buffer,
      caption: text && text.trim() ? text : undefined,
      mimetype,
    });
  } else {
    // Teks ber-URL → Baileys generate link preview otomatis (via link-preview-js).
    await sess.sock.sendMessage(chatId, { text: text ?? '' });
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
  hasCreds,
  isConnected,
  sendMessage,
  rescan,
  requestPairingCode,
  logoutSession,
};
