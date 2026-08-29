'use strict';

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const config = require('../../config');
const sessionRepository = require('../repositories/sessionRepository');
const { HttpError } = require('../utils/httpError');

const RECONNECT_DELAYS = [3000, 5000, 10000, 20000, 30000]; // ms
const QR_TTL_MS = 60000; // validitas QR backstop
const PAIRING_CODE_TTL_MS = 3 * 60 * 1000; // 3 menit untuk pairing code

/**
 * Registry sesi runtime.
 * Map<sessionId, SessionState>
 */
const registry = new Map();

function ensureAuthDir() {
  fs.mkdirSync(config.authDir, { recursive: true });
}

/**
 * Helper: folder sesi LocalAuth untuk satu clientId.
 * wwebjs LocalAuth menyimpan di: `<authDir>/session-<id>/`
 */
function getSessionAuthDir(id) {
  return path.join(config.authDir, `session-${id}`);
}

/**
 * Apakah sesi punya data auth yang tersimpan dan bisa di-resume?
 * LocalAuth wwebjs membuat folder `session-<id>` yang berisi `Default/` Chromium profile.
 * Sesi valid memiliki folder `session-<id>/Default` atau file indexeddb/cookies di dalamnya.
 */
function hasCreds(id) {
  const dir = getSessionAuthDir(id);
  if (!fs.existsSync(dir)) return false;
  try {
    const entries = fs.readdirSync(dir);
    // Folder Default/ atau file cookies/indexeddb menandakan auth ada
    if (entries.includes('Default')) return true;
    return entries.length > 0;
  } catch (_) {
    return false;
  }
}

function sessionExists(id) {
  return !!sessionRepository.findById(id);
}

function generateUniqueSlug(name) {
  const base =
    String(name ?? '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'sesi';

  let slug = base;
  let counter = 2;
  while (sessionRepository.findById(slug) || fs.existsSync(getSessionAuthDir(slug))) {
    slug = `${base}-${counter}`;
    counter += 1;
  }
  return slug;
}

function createSessionState(id, name) {
  return {
    id,
    name,
    status: 'uninitialized',
    qrDataUrl: null,
    qrExpiresAt: null,
    pairingPhone: null,
    pairingRequested: false,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    userInfo: null,
    lastError: null,
    client: null,
    starting: false,
    reconnectTimer: null,
    qrExpiryTimer: null,
    pairExpiryTimer: null,
    reconnectAttempts: 0,
    stopReconnect: false,
    wasConnected: false,
    gen: 0,
  };
}

/* ---------------- timer helpers ---------------- */

function clearReconnect(sess) {
  if (sess.reconnectTimer) {
    clearTimeout(sess.reconnectTimer);
    sess.reconnectTimer = null;
  }
}

function clearQrExpiry(sess) {
  if (sess.qrExpiryTimer) {
    clearTimeout(sess.qrExpiryTimer);
    sess.qrExpiryTimer = null;
  }
}

function clearPairExpiry(sess) {
  if (sess.pairExpiryTimer) {
    clearTimeout(sess.pairExpiryTimer);
    sess.pairExpiryTimer = null;
  }
}

function scheduleQrExpiry(sess) {
  clearQrExpiry(sess);
  sess.qrExpiryTimer = setTimeout(() => {
    sess.qrExpiryTimer = null;
    if (sess.status !== 'qr') return;
    console.log(`[wa:${sess.id}] QR kedaluwarsa — pairing dihentikan, tunggu request manual.`);
    sess.status = 'qr_expired';
    sess.qrDataUrl = null;
    sess.qrExpiresAt = null;
    sess.lastError = 'QR kedaluwarsa — silakan request QR baru.';
    destroyClientQuietly(sess);
  }, QR_TTL_MS);
}

function schedulePairExpiry(sess) {
  clearPairExpiry(sess);
  sess.pairExpiryTimer = setTimeout(() => {
    sess.pairExpiryTimer = null;
    if (sess.status !== 'pairing_code') return;
    console.log(`[wa:${sess.id}] kode pairing kedaluwarsa — pairing dihentikan, tunggu request manual.`);
    sess.status = 'qr_expired';
    sess.pairingCode = null;
    sess.pairingCodeExpiresAt = null;
    sess.lastError = 'Kode pairing kedaluwarsa — minta kode baru atau pakai QR.';
    destroyClientQuietly(sess);
  }, PAIRING_CODE_TTL_MS);
}

function destroyClientQuietly(sess) {
  const client = sess.client;
  sess.client = null;
  if (client) {
    try {
      client.destroy().catch(() => {});
    } catch (_) {}
  }
}

function scheduleReconnect(sess) {
  if (sess.stopReconnect) return;
  // Jangan auto-reconnect bila belum pernah connected DAN tidak punya creds
  if (!sess.wasConnected && !hasCreds(sess.id)) return;
  clearReconnect(sess);

  const delay =
    RECONNECT_DELAYS[
      Math.min(sess.reconnectAttempts, RECONNECT_DELAYS.length - 1)
    ];
  sess.reconnectAttempts += 1;
  sess.status = 'connecting';
  console.log(`[wa:${sess.id}] mencoba koneksi ulang dalam ${delay / 1000}s (attempt ${sess.reconnectAttempts})…`);

  sess.reconnectTimer = setTimeout(() => {
    sess.reconnectTimer = null;
    start(sess.id).catch((err) => {
      console.error(`[wa:${sess.id}] gagal start saat reconnect:`, err);
    });
  }, delay);
}

/* ---------------- client event wiring ---------------- */

function wireClientEvents(sess, client, gen) {
  client.on('qr', async (qrText) => {
    if (sess.gen !== gen || sess.client !== client) return;

    // Jalur kode pairing: jika pairingPhone ter-set, minta kode alih-alih QR
    if (sess.pairingPhone) {
      if (sess.pairingRequested) return;
      sess.pairingRequested = true;
      try {
        console.log(`[wa:${sess.id}] meminta kode pairing untuk ${sess.pairingPhone}…`);
        const code = await client.requestPairingCode(sess.pairingPhone);
        if (sess.gen !== gen || sess.client !== client) return;
        sess.status = 'pairing_code';
        sess.pairingCode = code;
        sess.pairingCodeExpiresAt = Date.now() + PAIRING_CODE_TTL_MS;
        sess.lastError = null;
        schedulePairExpiry(sess);
        console.log(`[wa:${sess.id}] kode pairing dibuat:`, code);
      } catch (err) {
        if (sess.gen !== gen || sess.client !== client) return;
        console.error(`[wa:${sess.id}] gagal meminta kode pairing:`, err?.message || err);
        sess.status = 'qr_expired';
        sess.pairingCode = null;
        sess.pairingCodeExpiresAt = null;
        sess.lastError =
          'WhatsApp menolak permintaan kode pairing — pastikan nomor benar & terdaftar di WhatsApp.';
        destroyClientQuietly(sess);
      }
      return;
    }

    // Jalur QR biasa
    try {
      sess.qrDataUrl = await QRCode.toDataURL(qrText, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 320,
      });
      sess.qrExpiresAt = Date.now() + QR_TTL_MS;
      sess.status = 'qr';
      sess.lastError = null;
      scheduleQrExpiry(sess);
      console.log(`[wa:${sess.id}] QR baru siap discan`);
    } catch (err) {
      console.error(`[wa:${sess.id}] error generate QR dataUrl:`, err);
    }
  });

  client.on('authenticated', () => {
    if (sess.gen !== gen || sess.client !== client) return;
    console.log(`[wa:${sess.id}] terautentikasi`);
    clearQrExpiry(sess);
    clearPairExpiry(sess);
    sess.qrDataUrl = null;
    sess.qrExpiresAt = null;
    sess.pairingCode = null;
    sess.pairingCodeExpiresAt = null;
    sess.pairingPhone = null;
    sess.pairingRequested = false;
  });

  client.on('ready', () => {
    if (sess.gen !== gen || sess.client !== client) return;
    clearReconnect(sess);
    clearQrExpiry(sess);
    clearPairExpiry(sess);
    sess.reconnectAttempts = 0;
    sess.status = 'connected';
    sess.wasConnected = true;
    sess.lastError = null;

    const info = client.info;
    const wid = info?.wid?._serialized || info?.wid?.user || '';
    const number = wid.split('@')[0].split(':')[0] || '';
    const name = info?.pushname || sess.name || '';
    sess.userInfo = { number, name };
    console.log(`[wa:${sess.id}] terhubung sebagai ${name} ${number}`);
  });

  client.on('auth_failure', (msg) => {
    if (sess.gen !== gen || sess.client !== client) return;
    console.error(`[wa:${sess.id}] auth_failure:`, msg);
    clearReconnect(sess);
    clearQrExpiry(sess);
    clearPairExpiry(sess);
    sess.status = 'auth_failure';
    sess.lastError = msg || 'Autentikasi gagal';
    sess.wasConnected = false;
    sess.client = null;
  });

  client.on('disconnected', (reason) => {
    if (sess.gen !== gen || sess.client !== client) return;
    console.log(`[wa:${sess.id}] terputus: ${reason}`);
    clearQrExpiry(sess);
    clearPairExpiry(sess);
    sess.status = 'disconnected';
    sess.lastError = `Terputus: ${reason}`;
    sess.client = null;

    if (reason === 'LOGOUT' || reason === 'NAVIGATION') {
      sess.status = 'auth_failure';
      sess.lastError = 'Sesi di-logout dari WhatsApp';
      sess.wasConnected = false;
      return;
    }

    scheduleReconnect(sess);
  });
}

/* ---------------- core lifecycle ---------------- */

async function start(id) {
  ensureAuthDir();
  let sess = registry.get(id);
  if (!sess) {
    const row = sessionRepository.findById(id);
    if (!row) throw new Error(`Sesi "${id}" tidak ditemukan di database`);
    sess = createSessionState(id, row.name);
    registry.set(id, sess);
  }

  if (sess.starting) return;
  if (sess.client && sess.status === 'connected') return;

  sess.starting = true;
  sess.status = 'connecting';
  const gen = sess.gen;

  try {
    // Matikan client lama jika ada
    if (sess.client) {
      destroyClientQuietly(sess);
    }

    const puppeteerArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ];

    const client = new Client({
      authStrategy: new LocalAuth({
        dataPath: config.authDir,
        clientId: sess.id,
      }),
      puppeteer: {
        headless: true,
        args: puppeteerArgs,
      },
    });

    sess.client = client;
    wireClientEvents(sess, client, gen);

    // initialize() wwebjs async (menyalakan Puppeteer + WA Web)
    client.initialize().catch((err) => {
      if (sess.gen !== gen) return;
      console.error(`[wa:${sess.id}] error initialize wwebjs:`, err?.message || err);
      sess.status = 'disconnected';
      sess.lastError = err?.message || 'Gagal memulai WhatsApp client';
      scheduleReconnect(sess);
    });
  } catch (err) {
    if (sess.gen !== gen) return;
    console.error(`[wa:${sess.id}] error start:`, err);
    sess.status = 'disconnected';
    sess.lastError = err?.message || 'Gagal inisialisasi sesi';
    scheduleReconnect(sess);
  } finally {
    sess.starting = false;
  }
}

/**
 * Start semua sesi yang punya creds tersimpan (dipanggil saat server boot).
 * Sesi tanpa creds TIDAK di-start (anti-pairing-loop).
 */
function startAll() {
  ensureAuthDir();
  const rows = sessionRepository.findAll();
  for (const row of rows) {
    if (!registry.has(row.id)) {
      registry.set(row.id, createSessionState(row.id, row.name));
    }
    if (hasCreds(row.id)) {
      console.log(`[boot] start sesi "${row.id}" (creds ada)…`);
      start(row.id).catch((err) => {
        console.error(`[boot] gagal start sesi "${row.id}":`, err);
      });
    } else {
      console.log(`[boot] sesi "${row.id}" belum punya creds — tunggu scan manual.`);
    }
  }
}

async function destroy(id) {
  const sess = registry.get(id);
  if (!sess) return;
  sess.gen += 1;
  sess.stopReconnect = true;
  clearReconnect(sess);
  clearQrExpiry(sess);
  clearPairExpiry(sess);
  sess.pairingPhone = null;
  sess.pairingRequested = false;

  const client = sess.client;
  sess.client = null;
  if (client) {
    try {
      await client.destroy();
    } catch (_) {}
  }
  sess.status = 'uninitialized';
  sess.qrDataUrl = null;
  sess.qrExpiresAt = null;
  sess.pairingCode = null;
  sess.pairingCodeExpiresAt = null;
}

async function destroyAll() {
  await Promise.all([...registry.keys()].map((id) => destroy(id)));
}

/* ---------------- CRUD sesi ---------------- */

async function addSession(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new HttpError(400, 'Nama sesi wajib diisi');
  const id = generateUniqueSlug(trimmed);
  const row = sessionRepository.create({ id, name: trimmed });
  const sess = createSessionState(id, row.name);
  registry.set(id, sess);
  return getStatus(id);
}

function renameSession(id, name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new HttpError(400, 'Nama sesi wajib diisi');
  if (!sessionExists(id)) throw new HttpError(404, 'Sesi tidak ditemukan');
  sessionRepository.updateName(id, trimmed);
  const sess = registry.get(id);
  if (sess) sess.name = trimmed;
  return getStatus(id);
}

async function deleteSession(id) {
  if (!sessionExists(id)) throw new HttpError(404, 'Sesi tidak ditemukan');
  await destroy(id);
  sessionRepository.remove(id);
  registry.delete(id);
  try {
    fs.rmSync(getSessionAuthDir(id), { recursive: true, force: true });
  } catch (_) {}
}

/* ---------------- pairing / koneksi ---------------- */

async function rescan(id) {
  if (!sessionExists(id)) throw new HttpError(404, 'Sesi tidak ditemukan');
  let sess = registry.get(id);
  if (!sess) {
    const row = sessionRepository.findById(id);
    sess = createSessionState(id, row.name);
    registry.set(id, sess);
  }
  const wasAuthFailure = sess.status === 'auth_failure';
  sess.pairingPhone = null;
  sess.pairingRequested = false;
  sess.stopReconnect = true;

  await destroy(id);
  if (wasAuthFailure || !hasCreds(id)) {
    clearReconnect(sess);
    try {
      fs.rmSync(getSessionAuthDir(id), { recursive: true, force: true });
    } catch (_) {}
  }
  sess.stopReconnect = false;
  await start(id);
}

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

async function requestPairingCode(id, phone) {
  if (!sessionExists(id)) throw new HttpError(404, 'Sesi tidak ditemukan');
  const normalized = normalizePairingPhone(phone);
  let sess = registry.get(id);
  if (!sess) {
    const row = sessionRepository.findById(id);
    sess = createSessionState(id, row.name);
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
  clearReconnect(sess);
  try {
    fs.rmSync(getSessionAuthDir(id), { recursive: true, force: true });
  } catch (_) {}
  sess.pairingPhone = normalized;
  sess.pairingRequested = false;
  sess.pairingCode = null;
  sess.pairingCodeExpiresAt = null;
  sess.stopReconnect = false;
  await start(id);
  return getStatus(id);
}

async function logoutSession(id) {
  if (!sessionExists(id)) throw new HttpError(404, 'Sesi tidak ditemukan');
  const sess = registry.get(id);
  if (sess) {
    sess.gen += 1;
    sess.stopReconnect = true;
    clearReconnect(sess);
    clearQrExpiry(sess);
    clearPairExpiry(sess);
    sess.wasConnected = false;
    sess.pairingPhone = null;
    sess.pairingRequested = false;
    const client = sess.client;
    sess.client = null;
    if (client) {
      try {
        await client.logout();
      } catch (_) {}
      try {
        await client.destroy();
      } catch (_) {}
    }
    sess.status = 'uninitialized';
    sess.qrDataUrl = null;
    sess.qrExpiresAt = null;
    sess.userInfo = null;
    sess.lastError = null;
  }
  try {
    fs.rmSync(getSessionAuthDir(id), { recursive: true, force: true });
  } catch (_) {}
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
  return !!(sess && sess.status === 'connected' && sess.client);
}

/**
 * Normalisasi chatId untuk wwebjs:
 * Format wwebjs: `<number>@c.us` (personal) atau `<id>@g.us` (grup).
 * Kompatibel dengan input format Baileys (`<number>@s.whatsapp.net`) atau nomor polos (`628xxx`).
 */
function normalizeWwebChatId(chatId) {
  const raw = String(chatId ?? '').trim();
  if (raw.endsWith('@c.us') || raw.endsWith('@g.us')) return raw;
  if (raw.endsWith('@s.whatsapp.net')) {
    return raw.replace('@s.whatsapp.net', '@c.us');
  }
  const digits = raw.replace(/\D/g, '');
  return `${digits}@c.us`;
}

/**
 * Kirim pesan ke sebuah chatId dari sesi tertentu.
 * content: { text?, mediaPath? } — bila mediaPath ada, text jadi caption.
 * Menggunakan wwebjs client.sendMessage().
 */
async function sendMessage(id, chatId, { text, mediaPath }) {
  const sess = registry.get(id);
  if (!sess) throw new Error(`Sesi "${id}" tidak ditemukan`);
  if (sess.status !== 'connected' || !sess.client) {
    throw new Error(`WhatsApp sesi "${sess.name || id}" belum terhubung`);
  }

  const target = normalizeWwebChatId(chatId);

  if (mediaPath) {
    const abs = path.resolve(config.uploadDir, mediaPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`File media tidak ditemukan: ${mediaPath}`);
    }
    const media = MessageMedia.fromFilePath(abs);
    await sess.client.sendMessage(target, media, {
      caption: text && text.trim() ? text : undefined,
    });
  } else {
    // wwebjs otomatis merender link preview di WhatsApp Web
    await sess.client.sendMessage(target, text ?? '', {
      linkPreview: true,
    });
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
