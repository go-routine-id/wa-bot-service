'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { verifyRS256, decodeHeader, JwtError } = require('../src/utils/jwt');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });

const b64 = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString('base64url');

/** Terbitkan token RS256 seperti yang dilakukan account-service. */
function sign(payload, { alg = 'RS256', kid = 'default', key = privateKey } = {}) {
  const head = b64({ alg, typ: 'JWT', kid });
  const body = b64(payload);
  const sig = crypto
    .sign('RSA-SHA256', Buffer.from(`${head}.${body}`, 'ascii'), key)
    .toString('base64url');
  return `${head}.${body}.${sig}`;
}

const now = () => Math.floor(Date.now() / 1000);
const basePayload = (over = {}) => ({
  sub: 'acc-1',
  org_id: 'org-1',
  permissions: ['wa-bot:*'],
  principal_type: 'human',
  token_type: 'access',
  iss: 'account-service',
  exp: now() + 900,
  iat: now(),
  jti: 'j1',
  ...over,
});

const OPTS = { issuer: 'account-service' };

test('token sah lolos dan payload-nya utuh', () => {
  const p = verifyRS256(sign(basePayload()), PEM, OPTS);
  assert.strictEqual(p.sub, 'acc-1');
  assert.strictEqual(p.org_id, 'org-1');
  assert.deepStrictEqual(p.permissions, ['wa-bot:*']);
});

test('payload yang diubah tanpa tanda tangan baru DITOLAK', () => {
  const token = sign(basePayload());
  const [h, , s] = token.split('.');
  // Naikkan hak akses jadi platform admin — persis yang akan dicoba penyerang.
  const jahat = `${h}.${b64(basePayload({ permissions: ['*'] }))}.${s}`;
  assert.throws(() => verifyRS256(jahat, PEM, OPTS), (e) => e.reason === 'bad_signature');
});

test('ditandatangani kunci lain DITOLAK', () => {
  const lain = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.throws(
    () => verifyRS256(sign(basePayload(), { key: lain }), PEM, OPTS),
    (e) => e.reason === 'bad_signature'
  );
});

// Dua serangan klasik pada JWT. Keduanya lolos bila `alg` dari header dipercaya.
test('alg "none" DITOLAK', () => {
  const head = b64({ alg: 'none', typ: 'JWT' });
  const body = b64(basePayload());
  assert.throws(() => verifyRS256(`${head}.${body}.`, PEM, OPTS), (e) => e.reason === 'bad_alg');
});

test('alg "HS256" DITOLAK — kunci publik tidak boleh jadi rahasia HMAC', () => {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(basePayload());
  const sig = crypto.createHmac('sha256', PEM).update(`${head}.${body}`).digest('base64url');
  assert.throws(() => verifyRS256(`${head}.${body}.${sig}`, PEM, OPTS), (e) => e.reason === 'bad_alg');
});

test('token kedaluwarsa ditolak dengan reason "expired"', () => {
  // reason ini yang membuat klien tahu harus me-refresh, bukan menyerah.
  assert.throws(
    () => verifyRS256(sign(basePayload({ exp: now() - 3600 })), PEM, OPTS),
    (e) => e.reason === 'expired'
  );
});

test('selisih jam kecil ditoleransi', () => {
  const p = verifyRS256(sign(basePayload({ exp: now() - 5 })), PEM, {
    ...OPTS,
    clockToleranceSec: 30,
  });
  assert.strictEqual(p.sub, 'acc-1');
});

test('issuer asing ditolak', () => {
  assert.throws(
    () => verifyRS256(sign(basePayload({ iss: 'penyerang' })), PEM, OPTS),
    (e) => e.reason === 'bad_issuer'
  );
});

test('audience ditegakkan hanya bila diminta', () => {
  const token = sign(basePayload({ aud: ['wa-bot'] }));
  assert.ok(verifyRS256(token, PEM, { ...OPTS, audience: 'wa-bot' }));
  assert.throws(
    () => verifyRS256(token, PEM, { ...OPTS, audience: 'service-lain' }),
    (e) => e.reason === 'bad_audience'
  );
  // Tanpa opsi audience, token beraudience apa pun lolos — account-service
  // sendiri tidak memvalidasi aud, jadi ini keputusan sadar di sisi kita.
  assert.ok(verifyRS256(token, PEM, OPTS));
});

test('bentuk token ngawur tidak membuat crash', () => {
  for (const t of ['', 'bukan-token', 'a.b', 'a.b.c.d', null, undefined]) {
    assert.throws(() => verifyRS256(t, PEM, OPTS), JwtError, `input: ${t}`);
  }
});

test('decodeHeader membaca kid tanpa verifikasi', () => {
  assert.strictEqual(decodeHeader(sign(basePayload(), { kid: 'k-2026' })).kid, 'k-2026');
});
