'use strict';

const crypto = require('node:crypto');
const config = require('../../config');

/**
 * Klien ke account-service (shared service, Rust).
 *
 * Dua hal yang diambil dari sana:
 *   1. Kunci publik RS256 — untuk memverifikasi JWT SENDIRI, tanpa round-trip
 *      per request. Ini yang disarankan panduan integrasinya.
 *   2. /auth/whoami — hanya untuk jalur `X-API-Key` mentah, yang tidak bisa
 *      diverifikasi lokal karena bukan JWT.
 *
 * Keduanya di-cache. Tanpa cache, jalur API key membayar satu hop jaringan per
 * request dan kunci publik diambil ulang terus-menerus.
 */

/* ------------------------------------------------------------------ helper */

class AccountServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AccountServiceError';
    this.status = status;
  }
}

function baseUrl() {
  return (config.accountServiceUrl || '').replace(/\/+$/, '');
}

/** true bila integrasi account-service dikonfigurasi. */
function enabled() {
  return baseUrl() !== '';
}

async function getJson(path, { headers = {}, method = 'GET' } = {}) {
  const url = baseUrl() + path;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      signal: AbortSignal.timeout(config.accountServiceTimeoutMs),
    });
  } catch (err) {
    // Bedakan "account-service tak terjangkau" dari "kredensial ditolak":
    // yang pertama adalah gangguan kita sendiri dan layak 503, bukan 401 yang
    // membuat klien mengira kredensialnya salah lalu login ulang percuma.
    throw new AccountServiceError(
      `account-service tidak terjangkau di ${baseUrl()}: ${err.message}`,
      503
    );
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new AccountServiceError(body.message || `HTTP ${res.status}`, res.status);
  }
  return body.data !== undefined ? body.data : body;
}

/* -------------------------------------------------------- kunci publik */

let publicKeyCache = null; // { keyId, pem, fetchedAt }
let publicKeyInFlight = null;

/**
 * Kunci publik RS256, di-cache.
 *
 * `expectedKid` memicu pengambilan ulang saat token membawa `kid` yang tidak
 * kita kenal — inilah jalur rotasi kunci. Panduan account-service menegaskan
 * `expires_at` pada response BUKAN masa berlaku kunci (selalu "sekarang + 90
 * hari"), jadi rotasi tidak boleh disandarkan padanya.
 */
async function getPublicKey({ expectedKid = null, force = false } = {}) {
  const fresh =
    publicKeyCache &&
    Date.now() - publicKeyCache.fetchedAt < config.accountPublicKeyTtlMs &&
    (!expectedKid || publicKeyCache.keyId === expectedKid);

  if (fresh && !force) return publicKeyCache;

  // Satu request bersamaan saja: tanpa ini, lonjakan trafik saat cache dingin
  // menembakkan puluhan permintaan identik ke shared service.
  if (publicKeyInFlight) return publicKeyInFlight;

  publicKeyInFlight = (async () => {
    try {
      const data = await getJson('/api/v1/auth/public-key');
      publicKeyCache = {
        keyId: data.key_id,
        pem: data.public_key,
        fetchedAt: Date.now(),
      };
      return publicKeyCache;
    } finally {
      publicKeyInFlight = null;
    }
  })();

  return publicKeyInFlight;
}

/* -------------------------------------------------------------- whoami */

const whoamiCache = new Map(); // hash kunci → { data, fetchedAt }

function cacheKeyFor(apiKey) {
  // Kunci mentah TIDAK dipakai sebagai key map supaya tidak ikut tercetak bila
  // isi map pernah di-dump saat debugging.
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex');
}

/**
 * Introspeksi `X-API-Key` mentah lewat /auth/whoami.
 *
 * Cache-nya sengaja pendek: jalur ini SATU-SATUNYA yang melihat pencabutan
 * kredensial secara langsung, dan menahannya lama berarti kunci yang sudah
 * dicabut masih bisa dipakai selama itu.
 */
async function whoamiByApiKey(apiKey) {
  const key = cacheKeyFor(apiKey);
  const hit = whoamiCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < config.accountWhoamiCacheMs) return hit.data;

  const data = await getJson('/api/v1/auth/whoami', { headers: { 'X-API-Key': apiKey } });
  whoamiCache.set(key, { data, fetchedAt: Date.now() });

  // Buang entri kedaluwarsa sekalian; tanpa ini map tumbuh selamanya untuk
  // setiap kunci yang pernah dicoba — termasuk yang salah.
  for (const [k, v] of whoamiCache) {
    if (Date.now() - v.fetchedAt >= config.accountWhoamiCacheMs) whoamiCache.delete(k);
  }
  return data;
}

/** Dipakai test untuk memulai dari keadaan bersih. */
function resetCache() {
  publicKeyCache = null;
  publicKeyInFlight = null;
  whoamiCache.clear();
}

module.exports = { enabled, getPublicKey, whoamiByApiKey, resetCache, AccountServiceError };
