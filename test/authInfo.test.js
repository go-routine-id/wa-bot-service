'use strict';

/**
 * /api/auth-info menyajikan alamat account-service yang bisa dijangkau BROWSER.
 *
 * Backend sendiri menjangkau account-service lewat URL internal (loopback /
 * private network) untuk verifikasi JWT, tetapi alamat itu tidak berarti apa
 * apa di sisi browser pengunjung domain publik. Karena itu ada dua env:
 *   - ACCOUNT_SERVICE_URL          → dipakai SERVER (verifikasi JWT).
 *   - ACCOUNT_SERVICE_PUBLIC_URL   → disajikan ke BROWSER lewat auth-info.
 * Tanpa env publik, perilaku lama dipertahankan: jatuh ke ACCOUNT_SERVICE_URL
 * (frontend & backend di mesin yang sama, mis. lokal dev).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const express = require('express');

/** Muat ulang config/route dengan env yang baru — config di-cache oleh Node. */
function muatUlang() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(__dirname, '..', 'src')) || k.includes('/config/')) delete require.cache[k];
  }
}

test('ACCOUNT_SERVICE_PUBLIC_URL menang; URL internal tetap untuk verifikasi JWT', () => {
  process.env.ACCOUNT_SERVICE_URL = 'http://account-internal.test';
  process.env.ACCOUNT_SERVICE_PUBLIC_URL = 'https://account.test/';
  muatUlang();
  const config = require('../config');

  // Browser diarahkan ke ingress publik, garis miring terakhir dipangkas.
  assert.strictEqual(config.accountServicePublicUrl, 'https://account.test');
  // Server tetap menjangkau alamat internal — jangan sampai ikut tertukar.
  assert.strictEqual(config.accountServiceUrl, 'http://account-internal.test');
});

test('tanpa ACCOUNT_SERVICE_PUBLIC_URL → jatuh ke URL internal (perilaku lama)', () => {
  process.env.ACCOUNT_SERVICE_URL = 'http://account-internal.test/';
  delete process.env.ACCOUNT_SERVICE_PUBLIC_URL;
  muatUlang();
  const config = require('../config');

  assert.strictEqual(config.accountServicePublicUrl, 'http://account-internal.test');
});

test('route /api/auth-info menyajikan URL publik, bukan alamat internal', async (t) => {
  process.env.ACCOUNT_SERVICE_URL = 'http://account-internal.test';
  process.env.ACCOUNT_SERVICE_PUBLIC_URL = 'https://account.test';
  muatUlang();
  const router = require('../src/routes/authInfoRoutes');

  const app = express();
  app.use(router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${server.address().port}/auth-info`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  assert.strictEqual(body.data.enabled, true);
  // Kontrak field TETAP "accountServiceUrl" — yang berubah hanya nilainya:
  // alamat yang bisa dicapai browser, bukan loopback milik server.
  assert.strictEqual(body.data.accountServiceUrl, 'https://account.test');
  assert.strictEqual(body.data.requiredPermission, 'wa-bot:*');
});
