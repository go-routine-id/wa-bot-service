'use strict';

/**
 * Jalur gRPC: ketiga model identitas, isolasi organisasi, dan streaming.
 *
 * Server gRPC dijalankan DI DALAM proses test dengan DB sementara, dan
 * account-service dipalsukan — token ditandatangani kunci yang diterbitkan test
 * ini sendiri. Tidak ada WhatsApp sungguhan yang tersentuh: mode 'queue' hanya
 * membangunkan queue worker, dan worker itu dijalankan server.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

let stub, tmp, grpc, klienBc, klienSs, server, svc, bRepo, rRepo;

test.before(async () => {
  stub = await stubAccountService();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-grpc-'));

  process.env.ACCOUNT_SERVICE_URL = stub.url;
  process.env.AUTH_REQUIRED_PERMISSION = 'wa-bot:*';
  process.env.DB_PATH = path.relative(path.join(__dirname, '..'), path.join(tmp, 'g.db'));
  process.env.AUTH_DIR = path.join(tmp, 'auth');
  process.env.UPLOAD_DIR = path.join(tmp, 'up');

  grpc = require('@grpc/grpc-js');
  const loader = require('@grpc/proto-loader');
  const { buatServer, PROTO_PATH } = require('../src/grpc/server');

  server = buatServer();
  const port = await new Promise((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(p)
    );
  });

  const def = loader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(def).wabot.v1;
  klienBc = new pkg.BroadcastService(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  klienSs = new pkg.SessionService(`127.0.0.1:${port}`, grpc.credentials.createInsecure());

  const sessionRepo = require('../src/repositories/sessionRepository');
  svc = require('../src/services/broadcastService');
  bRepo = require('../src/repositories/broadcastRepository');
  rRepo = require('../src/repositories/recipientRepository');
  sessionRepo.create({ id: 'sesi-a', name: 'Sesi A', orgId: 'org-A' });
  sessionRepo.create({ id: 'sesi-b', name: 'Sesi B', orgId: 'org-B' });
});

test.after(() => {
  if (klienBc) klienBc.close();
  if (klienSs) klienSs.close();
  if (server) server.forceShutdown();
  if (stub) stub.srv.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function meta({ token: t, extra = {} } = {}) {
  const m = new grpc.Metadata();
  if (t) m.set('authorization', `Bearer ${t}`);
  for (const [k, v] of Object.entries(extra)) m.set(k, v);
  return m;
}
const panggil = (klien, method, req, m) =>
  new Promise((resolve) =>
    klien[method](req, m, (err, res) => resolve(err ? { err } : { ok: res }))
  );

const buatBroadcast = (org, sesi) =>
  svc.create(
    { sessionId: sesi, mode: 'queue', ratePerMinute: 10, messageText: 'halo',
      recipients: '6281234567890, 6289876543210' },
    org
  );

/* ===================== model identitas ===================== */

test('MODEL 1 — human account diterima', async () => {
  const r = await panggil(klienSs, 'ListSessions', {}, meta({ token: token({ org_id: 'org-A' }) }));
  assert.ok(r.ok, r.err && r.err.details);
  assert.deepStrictEqual(r.ok.sessions.map((s) => s.id), ['sesi-a']);
});

test('MODEL 2 — service account (token-exchange) diterima', async () => {
  const t = token({ sub: 'svc-1', principal_type: 'service', org_id: 'org-B' });
  const r = await panggil(klienSs, 'ListSessions', {}, meta({ token: t }));
  assert.deepStrictEqual(r.ok.sessions.map((s) => s.id), ['sesi-b'], 'hanya sesi org-nya sendiri');
});

test('MODEL 3 — system account WAJIB menyebut organisasi lewat metadata', async () => {
  const sys = token({ sub: 'sys-1', principal_type: 'service', org_id: undefined });

  const tanpa = await panggil(klienSs, 'ListSessions', {}, meta({ token: sys }));
  assert.strictEqual(tanpa.err.code, grpc.status.INVALID_ARGUMENT);
  assert.match(tanpa.err.details, /X-Organization-Id/);

  const dengan = await panggil(klienSs, 'ListSessions', {},
    meta({ token: sys, extra: { 'x-organization-id': 'org-A' } }));
  assert.deepStrictEqual(dengan.ok.sessions.map((s) => s.id), ['sesi-a']);
});

/* ===================== penolakan ===================== */

test('penolakan dipetakan ke kode gRPC yang tepat', async () => {
  const kasus = [
    ['tanpa kredensial', meta(), grpc.status.UNAUTHENTICATED],
    ['token cacat', meta({ token: 'a.b.c' }), grpc.status.UNAUTHENTICATED],
    ['refresh token', meta({ token: token({ org_id: 'org-A', token_type: 'refresh' }) }), grpc.status.UNAUTHENTICATED],
    ['tanpa exp', meta({ token: token({ org_id: 'org-A', exp: undefined }) }), grpc.status.UNAUTHENTICATED],
    ['izin kurang', meta({ token: token({ org_id: 'org-A', permissions: ['email:*'] }) }), grpc.status.PERMISSION_DENIED],
    ['dua kredensial', meta({ token: token({ org_id: 'org-A' }), extra: { 'x-api-key': 'k' } }), grpc.status.INVALID_ARGUMENT],
  ];
  for (const [nama, m, harap] of kasus) {
    const r = await panggil(klienBc, 'ListBroadcasts', {}, m);
    assert.ok(r.err, `${nama} seharusnya ditolak`);
    assert.strictEqual(r.err.code, harap, `${nama}: kode gRPC tidak sesuai`);
  }
});

/* ===================== isolasi organisasi ===================== */

test('broadcast organisasi lain dibalas NOT_FOUND, bukan PERMISSION_DENIED', async () => {
  // Membedakan keduanya sudah membocorkan keberadaan datanya.
  const milikA = buatBroadcast('org-A', 'sesi-a');
  const tokenB = token({ org_id: 'org-B' });

  for (const method of ['GetBroadcast', 'CancelBroadcast']) {
    const r = await panggil(klienBc, method, { id: milikA.id }, meta({ token: tokenB }));
    assert.strictEqual(r.err.code, grpc.status.NOT_FOUND, `${method} membocorkan keberadaan data`);
  }

  const daftarB = await panggil(klienBc, 'ListBroadcasts', {}, meta({ token: tokenB }));
  assert.ok(!daftarB.ok.broadcasts.some((b) => Number(b.id) === milikA.id));
});

test('sesi organisasi lain tidak bisa dipakai sebagai pengirim', async () => {
  const r = await panggil(klienBc, 'CreateBroadcast',
    { session_id: 'sesi-a', mode: 'BROADCAST_MODE_QUEUE', message_text: 'x', recipients: '6281234567890' },
    meta({ token: token({ org_id: 'org-B' }) }));
  assert.strictEqual(r.err.code, grpc.status.INVALID_ARGUMENT);
  assert.match(r.err.details, /Sesi pengirim tidak ditemukan/);
});

test('batas paginasi ikut berlaku lewat gRPC', async () => {
  const asli = bRepo.list.bind(bRepo);
  const terlihat = [];
  bRepo.list = (arg) => { terlihat.push(arg); return asli(arg); };
  try {
    await panggil(klienBc, 'ListBroadcasts', { limit: 1000000 }, meta({ token: token({ org_id: 'org-A' }) }));
    await panggil(klienBc, 'ListBroadcasts', {}, meta({ token: token({ org_id: 'org-A' }) }));
  } finally {
    bRepo.list = asli;
  }
  assert.strictEqual(terlihat[0].limit, 500, 'limit raksasa harus dipangkas');
  assert.strictEqual(terlihat[1].limit, 50, 'limit 0 di proto = pakai bawaan, bukan nol baris');
});

/* ===================== streaming ===================== */

test('WatchBroadcast mengalirkan perubahan, dan hanya untuk broadcast itu', async () => {
  const milikA = buatBroadcast('org-A', 'sesi-a');
  const lain = buatBroadcast('org-A', 'sesi-a');

  const diterima = [];
  const stream = klienBc.WatchBroadcast({ id: milikA.id }, meta({ token: token({ org_id: 'org-A' }) }));
  stream.on('data', (e) => diterima.push(e));
  const selesai = new Promise((r) => stream.on('end', r).on('error', r));

  await new Promise((r) => setTimeout(r, 120)); // beri waktu handler memasang penyimak

  // Ubah broadcast LAIN dulu — tidak boleh muncul di stream ini.
  rRepo.updateStatus(rRepo.findByBroadcastId(lain.id)[0].id, { status: 'sent' });
  // Lalu yang disimak.
  const target = rRepo.findByBroadcastId(milikA.id)[0];
  rRepo.updateStatus(target.id, { status: 'sent', sentAt: new Date().toISOString() });
  await new Promise((r) => setTimeout(r, 120));

  assert.ok(diterima.length > 0, 'tidak menerima peristiwa apa pun');
  for (const e of diterima) {
    assert.strictEqual(Number(e.broadcast_id), milikA.id, 'peristiwa broadcast lain ikut bocor');
  }
  assert.ok(
    diterima.some((e) => e.event === 'recipient_changed' && e.recipient_changed.status === 'RECIPIENT_STATUS_SENT'),
    'perubahan penerima tidak sampai'
  );

  // Status akhir menutup stream — klien tidak perlu menebak kapan selesai.
  bRepo.markCompleted(milikA.id, 1, 0);
  await selesai;
});

test('WatchBroadcast milik organisasi lain ditolak sebelum menyimak apa pun', async () => {
  const milikA = buatBroadcast('org-A', 'sesi-a');
  const stream = klienBc.WatchBroadcast({ id: milikA.id }, meta({ token: token({ org_id: 'org-B' }) }));
  const err = await new Promise((r) => {
    stream.on('error', r);
    stream.on('data', () => r(new Error('menerima data padahal bukan miliknya')));
  });
  assert.strictEqual(err.code, grpc.status.NOT_FOUND);
});

test('penyimak dilepas saat stream berakhir — kalau tidak, bus menumpuk listener mati', async () => {
  const { bus, PERISTIWA } = require('../src/utils/eventBus');
  const sebelum = bus.listenerCount(PERISTIWA.PENERIMA_BERUBAH);

  const b = buatBroadcast('org-A', 'sesi-a');
  const stream = klienBc.WatchBroadcast({ id: b.id }, meta({ token: token({ org_id: 'org-A' }) }));
  // Penyimak 'data' WAJIB dipasang meski isinya tidak dipakai: tanpa itu stream
  // Node tetap dalam mode terhenti dan 'end' tidak pernah menyala — test akan
  // menggantung dan menuduh kode, padahal test-nya sendiri yang tidak membaca.
  stream.on('data', () => {});
  const selesai = new Promise((r) => stream.on('end', r).on('error', r));
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(bus.listenerCount(PERISTIWA.PENERIMA_BERUBAH), sebelum + 1, 'penyimak tidak terpasang');

  bRepo.markCancelled(b.id, 0, 0);
  await selesai;
  await new Promise((r) => setTimeout(r, 120));

  assert.strictEqual(bus.listenerCount(PERISTIWA.PENERIMA_BERUBAH), sebelum, 'penyimak tidak dilepas');
});
