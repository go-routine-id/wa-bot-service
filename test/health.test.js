'use strict';

/**
 * /health — kontrak health gate CI/CD.
 *
 * Dua sifat yang dikunci di sini:
 *  1. HTTP 200 tanpa kredensial apa pun (route di luar /api, sebelum
 *     authMiddleware) — gate deploy harus bisa memeriksa kesehatan proses
 *     tanpa memiliki token.
 *  2. Tidak menunggu koneksi WhatsApp — deploy perdana boleh sehat sebelum
 *     sesi di-scan.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const http = require('node:http');

let tmp;

test.before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-health-'));
  // config menempelkan DB_PATH ke ROOT — harus relatif, bukan absolut.
  process.env.DB_PATH = path.relative(path.join(__dirname, '..'), path.join(tmp, 'h.db'));
  process.env.AUTH_DIR = path.join(tmp, 'auth');
  process.env.UPLOAD_DIR = path.join(tmp, 'up');
});

test.after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('GET /health → 200 tanpa auth, tanpa sesi WhatsApp', async () => {
  const app = require('../src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.strictEqual(res.status, 200, 'health gate expect HTTP 200');
    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
    assert.ok(Number.isInteger(body.uptime), 'uptime berguna untuk debug deploy');
  } finally {
    server.close();
  }
});
