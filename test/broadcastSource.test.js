'use strict';

/**
 * Pencatatan sumber broadcast (web/api/grpc + pembuatnya) dan pandangan
 * lintas organisasi untuk admin platform (izin '*').
 *
 * Keduanya punya sifat yang sama: gejalanya senyap bila rusak — tidak ada
 * error, hanya data yang salah/tidak tercatat. Karena itu dikunci di sini.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

let svc;
let bRepo;
let sRepo;
let controller;

test.before(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-src-'));
  process.env.DB_PATH = path.relative(ROOT, path.join(tmp, 's.db'));
  process.env.AUTH_DIR = path.join(tmp, 'auth');

  sRepo = require('../src/repositories/sessionRepository');
  bRepo = require('../src/repositories/broadcastRepository');
  svc = require('../src/services/broadcastService');
  controller = require('../src/controllers/broadcastController');

  // Dua organisasi, masing-masing satu sesi — sumber kebenaran sesi untuk
  // validasi sessionId saat create.
  sRepo.create({ id: 'sesi-a', name: 'Sesi A', orgId: 'org-A' });
  sRepo.create({ id: 'sesi-b', name: 'Sesi B', orgId: 'org-B' });
});

const body = (sessionId = 'sesi-a') => ({
  sessionId,
  mode: 'queue',
  ratePerMinute: 2,
  messageText: 'halo',
  recipients: '6281234567890',
});

test('create mencatat source & ownerAccountId dari meta', () => {
  const b = svc.create(body(), 'org-A', { source: 'web', accountId: 'acc-1' });
  assert.strictEqual(b.source, 'web');
  assert.strictEqual(b.ownerAccountId, 'acc-1');
  assert.strictEqual(b.ownerOrgId, 'org-A');
});

test('create tanpa meta → source=api & ownerAccountId null', () => {
  const b = svc.create(body(), 'org-A');
  assert.strictEqual(b.source, 'api');
  assert.strictEqual(b.ownerAccountId, null);
});

test('retry mewarisi stamping sumber dari meta jalur pemanggil', () => {
  const asal = svc.create(body(), 'org-A', { source: 'api', accountId: 'acc-2' });
  // Buat satu recipient gagal (bukan invalid-number) supaya bisa di-retry.
  const rRepo = require('../src/repositories/recipientRepository');
  rRepo.bulkInsert(asal.id, [{ number: '6289999999999', status: 'failed', error: 'WhatsApp tidak terhubung' }]);
  bRepo.recalcCounts(asal.id);

  const lagi = svc.retry(asal.id, {}, 'org-A', { source: 'web', accountId: 'acc-1' });
  assert.strictEqual(lagi.source, 'web');
  assert.strictEqual(lagi.ownerAccountId, 'acc-1');
});

test('list biasa tersaring organisasi; allOrgs melintasi tenant', () => {
  svc.create(body(), 'org-A');
  svc.create(body('sesi-b'), 'org-B');

  const milikA = svc.list({}, 'org-A');
  assert.ok(milikA.every((b) => b.ownerOrgId === 'org-A'));

  const lintas = svc.list({}, 'org-A', { allOrgs: true });
  assert.ok(lintas.some((b) => b.ownerOrgId === 'org-B'), 'org-A harusnya melihat broadcast org-B');
});

test('getDetail: asing 404 tanpa allOrgs, terbaca dengan allOrgs', () => {
  const asing = svc.create(body('sesi-b'), 'org-B');

  assert.throws(() => svc.getDetail(asing.id, 'org-A'), /tidak ditemukan/);
  const d = svc.getDetail(asing.id, 'org-A', { allOrgs: true });
  assert.strictEqual(d.broadcast.ownerOrgId, 'org-B');
});

test('controller: scope=all tanpa izin * ditolak 403', () => {
  const res = { json() {} };
  const req = { query: { scope: 'all' }, auth: { orgId: 'org-A', permissions: ['wa-bot:*'] } };
  assert.throws(() => controller.list(req, res), (e) => e.statusCode === 403);
  assert.throws(
    () => controller.detail({ ...req, params: { id: '1' } }, res),
    (e) => e.statusCode === 403
  );
});

test('controller: scope=all dengan izin * berjalan', () => {
  // Controller memanggil res.json tanpa me-return nilainya — payload
  // ditangkap lewat stub, bukan nilai balik pemanggilan.
  const res = { json(d) { this.payload = d; } };
  const req = { query: { scope: 'all' }, auth: { orgId: 'org-A', permissions: ['*'], accountId: 'acc-adm' } };
  controller.list(req, res);
  assert.ok(Array.isArray(res.payload.data));
  assert.ok(res.payload.data.some((b) => b.ownerOrgId === 'org-B'));
});

test('controller: X-Client: web → source web; tanpa header → api', () => {
  const res = {
    status() { return this; },
    json(d) { this.payload = d; },
  };
  const reqWeb = {
    body: body(),
    auth: { orgId: 'org-A', permissions: ['wa-bot:*'], accountId: 'acc-9' },
    get: (h) => (String(h).toLowerCase() === 'x-client' ? 'web' : undefined),
  };
  controller.create(reqWeb, res);
  assert.strictEqual(res.payload.data.source, 'web');

  const resApi = { status() { return this; }, json(d) { this.payload = d; } };
  const reqApi = { ...reqWeb, get: () => undefined };
  controller.create(reqApi, resApi);
  assert.strictEqual(resApi.payload.data.source, 'api');
});
