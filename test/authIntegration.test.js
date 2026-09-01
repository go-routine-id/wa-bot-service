'use strict';

/**
 * Uji integrasi: ketiga model identitas account-service menembus seluruh
 * tumpukan HTTP wa-bot-service, dan datanya terisolasi antar organisasi.
 *
 * account-service dipalsukan — hanya endpoint kunci publiknya yang dipakai
 * verifikasi lokal. Token ditandatangani kunci yang diterbitkan test ini
 * sendiri, jadi pengujian TIDAK bergantung pada kredensial siapa pun dan bisa
 * dijalankan siapa saja, kapan saja.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(payload) {
  const h = b64({ alg: 'RS256', typ: 'JWT', kid: 'default' });
  const p = b64(payload);
  const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'ascii'), privateKey).toString('base64url');
  return `${h}.${p}.${s}`;
}
const now = () => Math.floor(Date.now() / 1000);

const token = (over = {}) =>
  sign({
    sub: 'acc-1', permissions: ['wa-bot:*'], principal_type: 'human',
    token_type: 'access', iss: 'account-service', exp: now() + 900, ...over,
  });

/** account-service tiruan: cukup melayani kunci publiknya. */
function stubAccountService() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/api/v1/auth/public-key')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, data: { key_id: 'default', algorithm: 'RS256', public_key: PEM } }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

let stub, app, base, tmp;

test.before(async () => {
  stub = await stubAccountService();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-e2e-'));

  // Env harus diset SEBELUM config/app di-require: keduanya membaca env sekali
  // saat modul dimuat.
  process.env.ACCOUNT_SERVICE_URL = stub.url;
  process.env.AUTH_REQUIRED_PERMISSION = 'wa-bot:*';
  process.env.DB_PATH = path.relative(path.join(__dirname, '..'), path.join(tmp, 'e2e.db'));
  process.env.AUTH_DIR = path.join(tmp, 'auth');
  process.env.UPLOAD_DIR = path.join(tmp, 'up');

  const expressApp = require('../src/app');
  await new Promise((r) => {
    app = expressApp.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${app.address().port}`;
});

test.after(() => {
  if (app) app.close();
  if (stub) stub.srv.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

async function req(pathname, { headers = {}, method = 'GET', body } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

/* ========================= ketiga model identitas ========================= */

test('MODEL 1 — human account diterima, datanya masuk ke org-nya', async () => {
  const r = await req('/api/templates', {
    method: 'POST',
    headers: bearer(token({ org_id: 'org-A' })),
    body: { name: 'Punya A', textContent: 'halo' },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
});

test('MODEL 2 — service account (token-exchange) diterima', async () => {
  const r = await req('/api/templates', {
    headers: bearer(token({ sub: 'svc-1', principal_type: 'service', org_id: 'org-A' })),
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.length, 1, 'melihat data org-A');
});

test('MODEL 3 — system account WAJIB menyebut organisasi', async () => {
  // org_id memang tidak ada pada token system account — dikonfirmasi di sumber
  // account-service ("System accounts have no organization").
  const sys = token({ sub: 'sys-1', principal_type: 'service', org_id: undefined });

  const tanpa = await req('/api/templates', { headers: bearer(sys) });
  assert.strictEqual(tanpa.status, 400);
  assert.match(tanpa.body.error, /X-Organization-Id/);

  const dengan = await req('/api/templates', {
    headers: { ...bearer(sys), 'X-Organization-Id': 'org-A' },
  });
  assert.strictEqual(dengan.status, 200);
  assert.strictEqual(dengan.body.data.length, 1, 'system account melihat org yang ia sebut');
});

/* ============================ isolasi & penolakan ============================ */

test('organisasi lain tidak melihat apa pun', async () => {
  const r = await req('/api/templates', { headers: bearer(token({ org_id: 'org-B' })) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.length, 0, 'data org-A tidak boleh bocor ke org-B');
});

test('kredensial ber-organisasi tidak bisa pindah lewat header', async () => {
  // Inti keamanannya: tanpa aturan ini, satu service account bisa membaca
  // seluruh tenant hanya dengan menambahkan satu header.
  const r = await req('/api/templates', {
    headers: { ...bearer(token({ org_id: 'org-B' })), 'X-Organization-Id': 'org-A' },
  });
  assert.strictEqual(r.body.data.length, 0, 'header tidak boleh menang atas org_id token');
});

test('tanpa izin wa-bot:* → 403', async () => {
  const r = await req('/api/templates', { headers: bearer(token({ org_id: 'org-A', permissions: ['email:*'] })) });
  assert.strictEqual(r.status, 403);
});

test('tanpa kredensial → 401', async () => {
  assert.strictEqual((await req('/api/templates')).status, 401);
});

test('token ditandatangani kunci lain → 401', async () => {
  const lain = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const h = b64({ alg: 'RS256', typ: 'JWT', kid: 'default' });
  const p = b64({ sub: 'x', org_id: 'org-A', permissions: ['wa-bot:*'], token_type: 'access', iss: 'account-service', exp: now() + 900 });
  const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'ascii'), lain).toString('base64url');
  assert.strictEqual((await req('/api/templates', { headers: bearer(`${h}.${p}.${s}`) })).status, 401);
});

test('refresh token ditolak', async () => {
  const r = await req('/api/templates', { headers: bearer(token({ org_id: 'org-A', token_type: 'refresh' })) });
  assert.strictEqual(r.status, 401);
});
