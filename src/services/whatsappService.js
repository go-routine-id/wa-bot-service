'use strict';

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const config = require('../../config');

const state = {
  status: 'uninitialized', // uninitialized | connecting | qr | connected | disconnected | auth_failure
  qrDataUrl: null,
  qrExpiresAt: null,
  userInfo: null,
  lastError: null,
  client: null,
};

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
  return state.status === 'connected' && !!state.client;
}

function createClient() {
  return new Client({
    authStrategy: new LocalAuth({ dataPath: config.authDir }),
    puppeteer: { headless: true },
  });
}

/**
 * Start (atau restart) client wwebjs. Fire-and-forget dari boot —
 * status 'qr' / 'connected' muncul async via event.
 */
async function start() {
  if (state.client) return;

  state.status = 'connecting';
  state.lastError = null;

  const client = createClient();
  state.client = client;

  client.on('qr', async (qr) => {
    state.status = 'qr';
    try {
      state.qrDataUrl = await QRCode.toDataURL(qr);
    } catch (err) {
      console.error('[wa] gagal generate QR:', err.message);
      state.qrDataUrl = null;
    }
    state.qrExpiresAt = Date.now() + 25000; // QR regenerasi ~30 detik
  });

  client.on('authenticated', () => {
    state.status = 'connecting';
  });

  client.on('ready', () => {
    state.status = 'connected';
    state.qrDataUrl = null;
    state.qrExpiresAt = null;
    state.lastError = null;
    state.userInfo = {
      number: client.info?.wid?.user ?? null,
      name: client.info?.pushname ?? null,
    };
    console.log('[wa] terhubung sebagai', state.userInfo.name, state.userInfo.number);
  });

  client.on('disconnected', (reason) => {
    console.log('[wa] disconnected:', reason);
    state.status = 'disconnected';
    state.lastError = reason;
    state.client = null;
  });

  client.on('auth_failure', (msg) => {
    console.log('[wa] auth_failure:', msg);
    state.status = 'auth_failure';
    state.lastError = msg;
  });

  try {
    await client.initialize();
  } catch (err) {
    console.error('[wa] initialize gagal:', err.message);
    state.status = 'auth_failure';
    state.lastError = err.message;
    state.client = null;
  }
}

/**
 * Kirim pesan ke sebuah chatId.
 * content: { text?, mediaPath?, } — bila mediaPath ada, text jadi caption.
 */
async function sendMessage(chatId, { text, mediaPath }) {
  if (!isConnected()) throw new Error('WhatsApp belum terhubung');

  let content;
  let options = {};
  if (mediaPath) {
    const abs = path.resolve(config.root, mediaPath);
    content = MessageMedia.fromFilePath(abs);
    if (text && text.trim()) options.caption = text;
  } else {
    content = text;
  }

  await state.client.sendMessage(chatId, content, options);
}

/** Hancurkan client tanpa hapus session (untuk rescan). */
async function destroy() {
  const client = state.client;
  state.client = null;
  state.status = 'uninitialized';
  state.qrDataUrl = null;
  state.qrExpiresAt = null;
  state.userInfo = null;
  state.lastError = null;
  if (client) {
    try {
      await client.destroy();
    } catch (_) {
      // abaikan — client mungkin sudah mati
    }
  }
}

/** Hancurkan + buat ulang client (memicu QR baru). */
async function rescan() {
  await destroy();
  await start();
}

/** Logout penuh + hapus session tersimpan. */
async function logout() {
  const client = state.client;
  state.client = null;
  if (client) {
    try {
      await client.logout();
    } catch (_) {
      // abaikan
    }
    try {
      await client.destroy();
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
