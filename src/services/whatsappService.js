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
 */
function hasCreds(id) {
  return fs.existsSync(path.join(config.authDir, `session-${id}`, '.linked'));
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

/** Slug unik terhadap tabel sessions + folder auth (backstop saat crash/partial). */
function generateUniqueSlug(name) {
  const base = slugify(name);
  let id = base;
  let n = 2;
  while (
    sessionRepository.findById(id) ||
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
    // uninitialized | connecting | qr | connected | disconnected | auth_failure
    status: 'uninitialized',
    qrDataUrl: null,
    qrExpiresAt: null,
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
    sess.qrExpiresAt = null; // QR wwebjs stabil (qrMaxRetries 0 = tak berotasi), tanpa TTL
    sess.lastError = null;
  });

  // Session berhasil diautentikasi & disimpan ke LocalAuth → tulis marker valid.
  client.on('authenticated', () => {
    if (sess.gen !== gen || sess.client !== client) return;
    try {
      fs.writeFileSync(path.join(sess.authDir, '.linked'), String(Date.now()));
    } catch (_) {
      // abaikan — marker bukan kritikal
    }
  });

  client.on('ready', () => {
    if (sess.gen !== gen || sess.client !== client) return;
    clearReconnect(sess);
    sess.status = 'connected';
    sess.qrDataUrl = null;
    sess.qrExpiresAt = null;
    sess.lastError = null;
    const wid = client.info?.wid;
    sess.userInfo = {
      // wid.user = digit nomor (tanpa "@c.us"); wid._serialized = "<digit>@c.us".
      number: wid?.user ? String(wid.user) : null,
      name: client.info?.pushname ?? null,
    };
    console.log(`[wa:${sess.id}] terhubung sebagai`, sess.userInfo.name, sess.userInfo.number);
  });

  client.on('auth_failure', (message) => {
    if (sess.gen !== gen || sess.client !== client) return;
    console.error(`[wa:${sess.id}] auth_failure:`, message);
    sess.status = 'auth_failure';
    sess.lastError = 'Sesi tidak valid — klik "Request QR baru" untuk scan ulang.';
    sess.stopReconnect = true;
    clearReconnect(sess);
    sess.client = null;
    // Destroy DULU sebelum buang profil — Chromium masih hidup saat auth_failure.
    // Re-entrant 'disconnected' dari destroy diabaikan: sess.client sudah null.
    client.destroy().catch(() => {});
    // auth_failure = LocalAuth basi/ditolak → buang profil agar QR baru muncul.
    cleanupCreds(sess);
  });

  client.on('disconnected', (reason) => {
    if (sess.gen !== gen || sess.client !== client) return;
    console.log(`[wa:${sess.id}] terputus:`, reason);
    sess.userInfo = null;
    sess.qrDataUrl = null;
    sess.qrExpiresAt = null;
    sess.client = null;
    // Tutup Chromium agar tak bocor & tak mengunci user-data-dir saat reconnect
    // (jeda reconnect 3s sudah cukup bagi Chromium untuk benar-benar tutup).
    client.destroy().catch(() => {});

    // Logout eksplisit dari perangkat tertaut → sesi invalid, butuh scan ulang.
    if (reason === 'LOGOUT') {
      sess.status = 'auth_failure';
      sess.lastError = 'Sesi di-logout dari WhatsApp';
      sess.stopReconnect = true;
      clearReconnect(sess);
      cleanupCreds(sess);
      return;
    }

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

/** Hapus profil LocalAuth sesi (creds basi) — dipakai auth_failure & rescan/logout. */
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
    } catch (err) {
      if (sess.gen !== gen) return; // destroy/rescan saat initialize berlangsung
      console.error(`[wa:${sess.id}] initialize gagal:`, err.message);
      // Putus referensi dulu, lalu destroy client agar Chromium tak bocor.
      sess.client = null;
      client.destroy().catch(() => {});
      // Event auth_failure biasanya sudah set status sebelum reject. Fallback untuk
      // reject TANPA event auth_failure (mis. Chromium gagal launch / jaringan
      // transient): ini BUKAN sesi invalid → jangan labeli auth_failure ("scan
      // ulang"). Retry reconnect dengan backoff.
      if (sess.status === 'connecting') {
        sess.status = 'disconnected';
        sess.lastError = err.message || 'Gagal inisialisasi WhatsApp Web';
        scheduleReconnect(sess);
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
  sess.userInfo = null;
  sess.lastError = null;
  if (client) {
    try {
      await client.destroy();
    } catch (_) {
      // abaikan — client mungkin sudah mati
    }
  }
}

/* ---------------- manajemen sesi ---------------- */

/** Boot: start semua sesi yang punya kredensial. Sesi tanpa kredensial tetap tampil (nonaktif). */
function startAll() {
  ensureAuthDir();
  for (const s of sessionRepository.findAll()) {
    if (!hasCreds(s.id)) continue; // tanpa kredensial → tidak di-start (anti-QR otomatis)
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
 * Hapus sesi total: row + folder auth + client. Controller WAJIB men-cancel
 * broadcast yang memakai sesi ini SEBELUM memanggil deleteSession (lihat sessionController).
 */
async function deleteSession(id) {
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
  sessionRepository.remove(id);
}

/**
 * Hentikan + buat ulang client satu sesi. "Request QR baru" = pairing baru →
 * buang kredensial basi. Basis keputusan harus penanda di disk (hasCreds),
 * bukan state runtime: flag runtime selalu false setelah boot sampai event
 * 'ready' pertama — klik "Hubungkan" pasca-restart tak boleh menghapus
 * kredensial sesi yang masih valid.
 */
async function rescan(id) {
  if (!sessionExists(id)) throw new HttpError(404, 'Sesi tidak ditemukan');
  let sess = registry.get(id);
  if (!sess) {
    const row = sessionRepository.findById(id);
    sess = createSession(id, row.name);
    registry.set(id, sess);
  }
  const wasAuthFailure = sess.status === 'auth_failure'; // destroy me-reset status
  sess.stopReconnect = true; // cegah timer lama menembak selama destroy
  await destroy(id);
  if (wasAuthFailure || !hasCreds(id)) {
    clearReconnect(sess);
    cleanupCreds(sess);
  }
  sess.stopReconnect = false;
  await start(id);
}

/** Logout penuh satu sesi: invalidasi di server WhatsApp + hapus kredensial; row sesi tetap. */
async function logoutSession(id) {
  if (!sessionExists(id)) throw new HttpError(404, 'Sesi tidak ditemukan');
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
    sess.userInfo = null;
    sess.lastError = null;
  }
  cleanupCreds({ authDir: path.join(config.authDir, `session-${id}`) });
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
    connected: sess?.status === 'connected' && !!sess?.client,
    hasQr: sess?.status === 'qr' && !!sess?.qrDataUrl,
    qrDataUrl: sess?.qrDataUrl ?? null,
    qrExpiresAt: sess?.qrExpiresAt ?? null,
    // Pairing code 8 digit tidak didukung whatsapp-web.js (QR only) — selalu false/null.
    hasPairingCode: false,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    userInfo: sess?.userInfo ?? null,
    lastError: sess?.lastError ?? null,
  };
}

function listSessions() {
  return sessionRepository.findAll().map((r) => getStatus(r.id));
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
  hasCreds,
  isConnected,
  sendMessage,
  rescan,
  logoutSession,
};
