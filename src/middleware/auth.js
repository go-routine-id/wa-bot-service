'use strict';

const config = require('../../config');
const accountService = require('../services/accountService');
const { verifyRS256, decodeHeader, JwtError } = require('../utils/jwt');
const { HttpError } = require('../utils/httpError');

/**
 * Autentikasi terhadap account-service, mendukung KETIGA model identitasnya.
 *
 * | Model           | Kredensial                        | Tenant (org) diambil dari |
 * |-----------------|-----------------------------------|---------------------------|
 * | Human account   | Bearer JWT dari /auth/login       | klaim `org_id`            |
 * | Service account | Bearer JWT dari /auth/token-exchange | klaim `org_id`         |
 * | Service account | X-API-Key mentah                  | `org_id` dari /auth/whoami|
 * | System account  | Bearer JWT dari /auth/system-token | header X-Organization-Id |
 *
 * System account adalah kredensial level platform dan sengaja TIDAK terikat
 * organisasi (`org_id: None` di sumber account-service), jadi ia harus menyebut
 * organisasi tujuannya sendiri.
 */

/** Header yang dipakai kredensial tanpa organisasi untuk menyebut tenant tujuan. */
const ORG_HEADER = 'x-organization-id';

/**
 * Cocokkan permission yang dibutuhkan.
 *
 * `"*"` adalah penanda platform admin di account-service dan diterima di mana
 * pun. Selain itu pencocokannya PERSIS — account-service tidak melakukan
 * ekspansi wildcard di sisi penerima, jadi kita pun tidak boleh mengarangnya:
 * memperlakukan `wa-bot:send` sebagai pemenuhan `wa-bot:*` akan memberi akses
 * yang tidak pernah diberikan siapa pun.
 */
function hasPermission(permissions, required) {
  if (!Array.isArray(permissions)) return false;
  return permissions.includes('*') || permissions.includes(required);
}

/** Verifikasi Bearer JWT secara lokal, dengan pengambilan ulang kunci saat kid asing. */
async function verifyBearer(token) {
  let kid = null;
  try {
    kid = decodeHeader(token).kid || null;
  } catch (_) {
    throw new HttpError(401, 'Format token tidak valid');
  }

  let key = await accountService.getPublicKey({ expectedKid: kid });

  const opts = {
    issuer: config.authIssuer,
    audience: config.authAudience || undefined,
    clockToleranceSec: config.authClockToleranceSec,
  };

  try {
    return verifyRS256(token, key.pem, opts);
  } catch (err) {
    // Tanda tangan gagal DAN kid-nya tidak cocok dengan kunci yang kita pegang
    // → kemungkinan besar kunci baru saja dirotasi. Ambil ulang sekali, lalu
    // coba sekali lagi. Tanpa ini, rotasi kunci di sisi account-service
    // membuat seluruh request gagal sampai TTL cache habis (default 24 jam).
    const mungkinRotasi = err instanceof JwtError && err.reason === 'bad_signature' && kid !== key.keyId;
    if (!mungkinRotasi) throw err;

    key = await accountService.getPublicKey({ force: true });
    return verifyRS256(token, key.pem, opts);
  }
}

/** Terjemahkan kegagalan verifikasi jadi HttpError yang informatif. */
function toHttpError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof accountService.AccountServiceError) {
    // Gangguan di sisi account-service (5xx, 429, tak terjangkau) BUKAN salah
    // kredensial. Membalas 401 membuat frontend membuang token lalu memaksa
    // login ulang percuma — dan itu menimpa semua pengguna sekaligus, karena
    // yang gagal biasanya pengambilan kunci publik yang dipakai bersama.
    const gangguanUpstream = !err.status || err.status >= 500 || err.status === 429;
    return new HttpError(gangguanUpstream ? 503 : 401, err.message);
  }
  if (err instanceof JwtError) {
    // 'expired' dipisahkan supaya klien tahu harus me-refresh, bukan menyerah.
    return new HttpError(401, err.reason === 'expired' ? 'Token kedaluwarsa' : err.message);
  }
  return new HttpError(401, 'Autentikasi gagal');
}

/**
 * Tentukan organisasi (tenant) yang berlaku untuk request ini.
 *
 * Header X-Organization-Id HANYA dihormati saat kredensialnya memang tidak
 * punya organisasi. Kredensial yang terikat organisasi TIDAK bisa memakainya
 * untuk keluar dari organisasinya sendiri — tanpa aturan ini, satu service
 * account bisa membaca data seluruh tenant hanya dengan menambah satu header.
 */
function resolveOrgId(tokenOrgId, req) {
  if (tokenOrgId) return tokenOrgId;

  const fromHeader = String(req.headers[ORG_HEADER] || '').trim();
  if (!fromHeader) {
    throw new HttpError(
      400,
      'Kredensial ini tidak terikat organisasi (system account). ' +
        'Sertakan header X-Organization-Id untuk menyebut organisasi tujuan.'
    );
  }
  return fromHeader;
}

/**
 * Middleware utama. Menempelkan `req.auth`:
 *   { accountId, orgId, principalType, permissions, via }
 */
async function authMiddleware(req, res, next) {
  // Preflight tidak membawa header kustom — biarkan CORS yang menilainya.
  if (req.method === 'OPTIONS') return next();

  if (!accountService.enabled()) {
    // Autentikasi nonaktif → tetap sediakan konteks tenant. Lapisan di bawah
    // dengan begitu punya SATU jalur saja; tidak ada cabang khusus "tanpa
    // organisasi" yang bisa lolos dari penyaringan.
    req.auth = {
      accountId: null,
      orgId: config.authFallbackOrgId,
      principalType: 'anonymous',
      permissions: [],
      via: 'disabled',
    };
    return next();
  }

  const apiKey = req.get('X-API-Key');
  const authorization = req.get('Authorization') || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

  // account-service memilih diam-diam mengabaikan Bearer bila keduanya dikirim,
  // dan dokumentasinya sendiri mendaftarkan itu sebagai kesalahan tersering.
  // Kita menolak eksplisit — mewarisi jebakannya tidak membantu siapa pun.
  if (apiKey && bearer) {
    return next(
      new HttpError(
        400,
        'Kirim salah satu saja: X-API-Key atau Authorization: Bearer, jangan keduanya'
      )
    );
  }

  try {
    let accountId;
    let orgId;
    let principalType;
    let permissions;
    let via;

    if (apiKey) {
      const who = await accountService.whoamiByApiKey(apiKey);
      accountId = who.user_id;
      orgId = who.org_id || null;
      principalType = who.principal_type;
      permissions = who.permissions;
      via = 'api-key';
    } else if (bearer) {
      const claims = await verifyBearer(bearer);
      // Token refresh TIDAK boleh dipakai memanggil API. Tanpa pemeriksaan ini,
      // refresh token yang berumur 7 hari menjadi kredensial akses penuh.
      // Dibandingkan KETAT. Bentuk sebelumnya (`claims.token_type && ...`)
      // meloloskan token yang tidak membawa klaim ini sama sekali — padahal
      // refresh token memikul `permissions` yang sama persis dengan access
      // token, jadi yang lolos akan berlaku sebagai kredensial penuh 7 hari.
      if (claims.token_type !== 'access') {
        throw new HttpError(
          401,
          `Butuh access token, bukan ${claims.token_type || 'token tanpa jenis'}`
        );
      }
      accountId = claims.sub;
      orgId = claims.org_id || null;
      principalType = claims.principal_type || 'human';
      permissions = claims.permissions;
      via = 'bearer';
    } else {
      throw new HttpError(
        401,
        'Autentikasi tidak ada. Sertakan Authorization: Bearer atau X-API-Key'
      );
    }

    if (!hasPermission(permissions, config.authRequiredPermission)) {
      throw new HttpError(
        403,
        `Akun ini tidak memegang izin ${config.authRequiredPermission}`
      );
    }

    req.auth = {
      accountId,
      orgId: resolveOrgId(orgId, req),
      principalType,
      permissions,
      via,
    };
    return next();
  } catch (err) {
    return next(toHttpError(err));
  }
}

module.exports = { authMiddleware, hasPermission, resolveOrgId, ORG_HEADER };
