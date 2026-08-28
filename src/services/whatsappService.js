'use strict';

const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const QRCode = require('qrcode');
const config = require('../../config');

const state = {
  status: 'uninitialized', // uninitialized | connecting | qr | connected | disconnected | auth_failure
  qrDataUrl: null,
  qrExpiresAt: null,
  userInfo: null,
  lastError: null,
  sock: null, // socket Baileys (makeWASocket) yang aktif
};

// Baileys v7 adalah ESM-only; proyek ini CJS → dimuat via import() dinamis (di-cache).
let baileys = null;
let pino = null;
let starting = null;       // promise start() berjalan (cegah race membuat 2 socket)
let reconnectTimer = null; // timer auto-reconnect backoff
let reconnectAttempts = 0;
let stopReconnect = false; // true saat destroy/logout; false saat rescan/start ulang

const RECONNECT_DELAYS = [3000, 5000, 10000, 20000, 30000]; // ms; cap 30s, ulang terus

function getStatus() {
  return {
    status: state.status,
    connected: state.status === 'connected',
    hasQr: state.status === 'qr' && !!state.qrDataUrl,
    qrDataUrl: state.qrDataUrl,
    qrExpiresAt: state.qrExpiresAt,
    userInfo: state.userInfo,
    lastError: state.lastError,
  };
}

function isConnected() {
  return state.status === 'connected' && !!state.sock;
}

async function loadBaileys() {
  if (!baileys) baileys = await import('@whiskeysockets/baileys');
  if (!pino) pino = (await import('pino')).default;
  return baileys;
}

function quietLogger() {
  return pino({ level: 'warn' });
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
}

function scheduleReconnect() {
  if (stopReconnect || reconnectTimer) return;
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)];
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (stopReconnect) return;
    console.log('[wa] mencoba koneksi ulang…');
    start().catch((err) => {
      console.error('[wa] reconnect gagal:', err.message);
    });
  }, delay);
}

/**
 * Terjemahkan sinyal Baileys (connection.update) ke status aplikasi.
 * `sock` adalah socket tempat event berasal — event dari socket lama (usai rescan)
 * diabaikan via pengecekan `state.sock !== sock`.
 */
async function handleConnectionUpdate(update, sock) {
  if (state.sock !== sock) return;

  // Belum ter-pair → Baileys mengirim QR baru (berputar ~30 detik).
  if (update.qr) {
    state.status = 'qr';
    try {
      state.qrDataUrl = await QRCode.toDataURL(update.qr);
    } catch (err) {
      console.error('[wa] gagal generate QR:', err.message);
      state.qrDataUrl = null;
    }
    state.qrExpiresAt = Date.now() + 25000; // QR regenerasi ~30 detik
    return;
  }

  if (update.connection === 'open') {
    clearReconnect();
    const user = sock.user;
    state.status = 'connected';
    state.qrDataUrl = null;
    state.qrExpiresAt = null;
    state.lastError = null;
    state.userInfo = {
      // creds.me.id berbentuk "628...:5@s.whatsapp.net" → ambil digit saja.
      number: user?.id ? String(user.id).split(':')[0].replace(/@.*$/, '') : null,
      name: user?.name ?? null,
    };
    console.log('[wa] terhubung sebagai', state.userInfo.name, state.userInfo.number);
    return;
  }

  if (update.connection === 'close') {
    const statusCode = update.lastDisconnect?.error?.output?.statusCode;
    const reason =
      update.lastDisconnect?.error?.message ||
      update.lastDisconnect?.error?.output?.payload?.message ||
      'connection closed';
    console.log('[wa] koneksi ditutup (statusCode:', statusCode + ')', reason);
    state.userInfo = null;

    // Fatal & permanen: sesi invalid/di-logout → minta scan ulang, berhenti reconnect.
    if (
      statusCode === baileys.DisconnectReason.loggedOut ||
      statusCode === baileys.DisconnectReason.badSession
    ) {
      state.status = 'auth_failure';
      state.lastError =
        statusCode === baileys.DisconnectReason.loggedOut
          ? 'Sesi di-logout dari WhatsApp'
          : 'Sesi tidak valid (bad session)';
      stopReconnect = true;
      clearReconnect();
      state.sock = null;
      return;
    }

    // Transient (connectionClosed=428, connectionLost=408, dll.) → disconnected + auto-reconnect.
    state.status = 'disconnected';
    state.lastError = reason;
    state.sock = null;
    scheduleReconnect();
  }
}

/**
 * Start (atau restart) koneksi Baileys. Fire-and-forget dari boot —
 * status 'qr' / 'connected' muncul async via event.
 */
function start() {
  if (state.sock) return Promise.resolve();
  if (starting) return starting;

  starting = (async () => {
    const lib = await loadBaileys();
    const { state: authState, saveCreds } = await lib.useMultiFileAuthState(config.authDir);
    const sock = lib.makeWASocket({
      auth: authState,
      printQRInTerminal: false,
      logger: quietLogger(),
    });
    state.sock = sock;
    state.status = 'connecting';
    state.lastError = null;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => handleConnectionUpdate(update, sock));
  })().finally(() => {
    starting = null;
  });

  return starting;
}

/**
 * Kirim pesan ke sebuah chatId (JID Baileys).
 * content: { text?, mediaPath?, } — bila mediaPath ada, text jadi caption.
 */
async function sendMessage(chatId, { text, mediaPath }) {
  if (!isConnected()) throw new Error('WhatsApp belum terhubung');

  if (mediaPath) {
    // FIX: media tersimpan relatif terhadap uploadDir, bukan root project.
    const abs = path.resolve(config.uploadDir, mediaPath);
    const buffer = fs.readFileSync(abs); // ENOENT → throw → recipient ditandai failed
    const mimetype = mime.lookup(abs) || 'image/*';
    await state.sock.sendMessage(chatId, {
      image: buffer,
      caption: text && text.trim() ? text : undefined,
      mimetype,
    });
  } else {
    // Teks ber-URL → Baileys generate link preview otomatis (via link-preview-js).
    await state.sock.sendMessage(chatId, { text: text ?? '' });
  }
}

/** Hentikan socket tanpa hapus session (dipakai rescan & shutdown). */
async function destroy() {
  const sock = state.sock;
  stopReconnect = true;
  clearReconnect();
  state.sock = null;
  state.status = 'uninitialized';
  state.qrDataUrl = null;
  state.qrExpiresAt = null;
  state.userInfo = null;
  state.lastError = null;
  if (sock) {
    try {
      await sock.end();
    } catch (_) {
      // abaikan — socket mungkin sudah mati
    }
  }
}

/** Hentikan + buat ulang socket. Setelah auth_failure, buang creds agar muncul QR baru. */
async function rescan() {
  if (state.status === 'auth_failure') {
    // Sesi rusak → hapus creds supaya pairing baru (QR) muncul, bukan gagal lagi.
    clearReconnect();
    try {
      fs.rmSync(config.authDir, { recursive: true, force: true });
    } catch (_) {
      // abaikan
    }
  }
  stopReconnect = true; // cegah timer lama menembak selama destroy
  await destroy();
  stopReconnect = false; // sesi baru boleh auto-reconnect
  await start();
}

/** Logout penuh + hapus session tersimpan. */
async function logout() {
  const sock = state.sock;
  stopReconnect = true;
  clearReconnect();
  state.sock = null;
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
  try {
    fs.rmSync(config.authDir, { recursive: true, force: true });
  } catch (_) {
    // abaikan
  }
  state.status = 'uninitialized';
  state.qrDataUrl = null;
  state.qrExpiresAt = null;
  state.userInfo = null;
  state.lastError = null;
}

module.exports = { start, getStatus, isConnected, sendMessage, rescan, logout, destroy };
