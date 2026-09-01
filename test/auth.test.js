'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');

process.env.ACCOUNT_SERVICE_URL = 'http://account.test';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(payload, kid = 'default') {
  const h = b64({ alg: 'RS256', typ: 'JWT', kid });
  const p = b64(payload);
  const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'ascii'), privateKey).toString('base64url');
  return `${h}.${p}.${s}`;
}
const now = () => Math.floor(Date.now() / 1000);

/** Klaim seperti yang diterbitkan account-service. */
const humanToken = (over = {}) =>
  sign({
    sub: 'acc-human', org_id: 'org-A', permissions: ['wa-bot:*'],
    principal_type: 'human', token_type: 'access', iss: 'account-service',
    exp: now() + 900, ...over,
  });

// System account: org_id memang TIDAK ADA — dikonfirmasi di sumber
// account-service (routes/auth/handlers.rs: "System accounts have no organization").
const systemToken = (over = {}) =>
  sign({
    sub: 'sys-1', permissions: ['wa-bot:*'], principal_type: 'service',
    token_type: 'access', iss: 'account-service', exp: now() + 900, ...over,
  });

/** Palsukan fetch global supaya tidak menyentuh jaringan. */
function stubFetch({ whoami = null, publicKeyPem = PEM, keyId = 'default' } = {}) {
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes('/auth/public-key')) {
      return {
        ok: true,
        json: async () => ({ success: true, data: { key_id: keyId, algorithm: 'RS256', public_key: publicKeyPem } }),
      };
    }
    if (String(url).includes('/auth/whoami')) {
      if (!whoami) return { ok: false, status: 401, json: async () => ({ success: false, message: 'Invalid API key' }) };
      return { ok: true, json: async () => ({ success: true, data: whoami }) };
    }
    throw new Error('URL tak terduga: ' + url);
  };
}

function load() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(__dirname, '..', 'src')) || k.includes('/config/')) delete require.cache[k];
  }
  const mw = require('../src/middleware/auth');
  require('../src/services/accountService').resetCache();
  return mw;
}

/** Jalankan middleware, kembalikan { auth, err }. */
async function run(headers = {}, method = 'GET') {
  const { authMiddleware } = load();
  const req = {
    method,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    get(name) { return this.headers[name.toLowerCase()]; },
  };
  return new Promise((resolve) => {
    authMiddleware(req, {}, (err) => resolve({ auth: req.auth, err }));
  });
}

/* ============================ tiga model auth ============================ */

test('MODEL 1 — human account: tenant dari klaim org_id', async () => {
  stubFetch();
  const { auth, err } = await run({ Authorization: `Bearer ${humanToken()}` });
  assert.ifError(err);
  assert.strictEqual(auth.orgId, 'org-A');
  assert.strictEqual(auth.principalType, 'human');
  assert.strictEqual(auth.via, 'bearer');
});

test('MODEL 2 — service account via token-exchange: tenant dari klaim org_id', async () => {
  stubFetch();
  const token = humanToken({ sub: 'acc-svc', principal_type: 'service', org_id: 'org-B' });
  const { auth, err } = await run({ Authorization: `Bearer ${token}` });
  assert.ifError(err);
  assert.strictEqual(auth.orgId, 'org-B');
  assert.strictEqual(auth.principalType, 'service');
});

test('MODEL 2b — service account via X-API-Key mentah: tenant dari whoami', async () => {
  stubFetch({
    whoami: { user_id: 'acc-svc', org_id: 'org-C', principal_type: 'service', permissions: ['wa-bot:*'] },
  });
  const { auth, err } = await run({ 'X-API-Key': 'kunci-rahasia' });
  assert.ifError(err);
  assert.strictEqual(auth.orgId, 'org-C');
  assert.strictEqual(auth.via, 'api-key');
});

test('MODEL 3 — system account: WAJIB menyebut organisasi lewat header', async () => {
  stubFetch();
  // Tanpa header → ditolak dengan pesan yang menjelaskan apa yang kurang.
  const tanpa = await run({ Authorization: `Bearer ${systemToken()}` });
  assert.strictEqual(tanpa.err.statusCode, 400);
  assert.match(tanpa.err.message, /X-Organization-Id/);

  const dengan = await run({
    Authorization: `Bearer ${systemToken()}`,
    'X-Organization-Id': 'org-D',
  });
  assert.ifError(dengan.err);
  assert.strictEqual(dengan.auth.orgId, 'org-D');
});

/* ======================= penutupan jalur eskalasi ======================= */

test('kredensial yang PUNYA organisasi tidak bisa pindah lewat header', async () => {
  stubFetch();
  // Inti keamanannya: tanpa aturan ini, satu service account bisa membaca data
  // seluruh tenant hanya dengan menambahkan satu header.
  const { auth, err } = await run({
    Authorization: `Bearer ${humanToken({ org_id: 'org-A' })}`,
    'X-Organization-Id': 'org-KORBAN',
  });
  assert.ifError(err);
  assert.strictEqual(auth.orgId, 'org-A', 'header tidak boleh menang atas org_id token');
});

test('tanpa izin wa-bot:* → 403, bukan 401', async () => {
  stubFetch();
  const { err } = await run({ Authorization: `Bearer ${humanToken({ permissions: ['email:*'] })}` });
  assert.strictEqual(err.statusCode, 403);
});

test('platform admin ("*") diterima', async () => {
  stubFetch();
  const { auth, err } = await run({ Authorization: `Bearer ${humanToken({ permissions: ['*'] })}` });
  assert.ifError(err);
  assert.strictEqual(auth.orgId, 'org-A');
});

test('izin mirip tidak dianggap cocok — tanpa ekspansi wildcard karangan', async () => {
  stubFetch();
  const { err } = await run({ Authorization: `Bearer ${humanToken({ permissions: ['wa-bot:send'] })}` });
  assert.strictEqual(err.statusCode, 403, 'wa-bot:send bukan wa-bot:*');
});

test('refresh token ditolak — hanya access token', async () => {
  stubFetch();
  const { err } = await run({ Authorization: `Bearer ${humanToken({ token_type: 'refresh' })}` });
  assert.strictEqual(err.statusCode, 401);
  assert.match(err.message, /access token/i);
});

test('mengirim X-API-Key DAN Bearer sekaligus ditolak tegas', async () => {
  stubFetch({ whoami: { user_id: 'x', org_id: 'org-X', principal_type: 'service', permissions: ['wa-bot:*'] } });
  const { err } = await run({ 'X-API-Key': 'k', Authorization: `Bearer ${humanToken()}` });
  assert.strictEqual(err.statusCode, 400, 'tidak boleh diam-diam memilih salah satu');
});

test('tanpa kredensial → 401', async () => {
  stubFetch();
  const { err } = await run({});
  assert.strictEqual(err.statusCode, 401);
});

test('token kedaluwarsa → 401 dengan pesan yang memandu refresh', async () => {
  stubFetch();
  const { err } = await run({ Authorization: `Bearer ${humanToken({ exp: now() - 3600 })}` });
  assert.strictEqual(err.statusCode, 401);
  assert.match(err.message, /kedaluwarsa/i);
});

test('account-service mati → 503, bukan 401', async () => {
  // Membalas 401 akan membuat klien mengira kredensialnya salah lalu login ulang
  // percuma, padahal yang bermasalah adalah kita.
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const { err } = await run({ Authorization: `Bearer ${humanToken()}` });
  assert.strictEqual(err.statusCode, 503);
});

test('preflight OPTIONS dilewatkan', async () => {
  stubFetch();
  const { err } = await run({}, 'OPTIONS');
  assert.ifError(err);
});

test('ACCOUNT_SERVICE_URL kosong → autentikasi nonaktif', async () => {
  const simpan = process.env.ACCOUNT_SERVICE_URL;
  process.env.ACCOUNT_SERVICE_URL = '';
  const { err, auth } = await run({});
  assert.ifError(err);
  assert.strictEqual(auth, undefined);
  process.env.ACCOUNT_SERVICE_URL = simpan;
});

test('kunci dirotasi (kid asing) → ambil ulang lalu berhasil', async () => {
  // Tanpa pengambilan ulang, rotasi kunci membuat SELURUH request gagal sampai
  // TTL cache habis — default 24 jam.
  const lama = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  let panggilan = 0;
  global.fetch = async (url) => {
    if (String(url).includes('/auth/public-key')) {
      panggilan += 1;
      const pem = (panggilan === 1 ? lama.publicKey : publicKey).export({ type: 'spki', format: 'pem' });
      return { ok: true, json: async () => ({ success: true, data: { key_id: panggilan === 1 ? 'lama' : 'baru', public_key: pem } }) };
    }
    throw new Error('tak terduga');
  };
  const { auth, err } = await run({ Authorization: `Bearer ${humanToken()}` });
  assert.ifError(err);
  assert.strictEqual(auth.orgId, 'org-A');
  assert.strictEqual(panggilan, 2, 'harus mengambil kunci ulang tepat sekali');
});
