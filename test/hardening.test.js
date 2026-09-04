'use strict';

/**
 * Tiga perbaikan hasil deep review sebelum jalur gRPC dibangun.
 *
 * Ketiganya punya sifat yang sama: gejalanya senyap. Tidak ada yang error,
 * tidak ada yang merah — hanya perilaku yang salah. Karena itu masing-masing
 * dikunci di sini.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/* ============ G: nilai env cacat dihentikan saat boot ============ */

/** Muat config di proses terpisah — config dibaca sekali saat modul dimuat. */
function muatConfig(env) {
  try {
    const out = execFileSync(
      process.execPath,
      ['-e', "process.stdout.write(String(require('./config').sendMaxAttempts))"],
      { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { ok: true, nilai: out.trim().split('\n').pop() };
  } catch (err) {
    return { ok: false, pesan: String(err.stderr || '') };
  }
}

test('SEND_MAX_ATTEMPTS yang bukan angka menghentikan proses saat boot', () => {
  // Tanpa ini `attempt >= NaN` selalu false dan percobaan ulang pengiriman
  // TIDAK PERNAH berhenti — menembaki WhatsApp tanpa batas.
  const r = muatConfig({ SEND_MAX_ATTEMPTS: 'three' });
  assert.strictEqual(r.ok, false, 'nilai cacat seharusnya menggagalkan boot');
  assert.match(r.pesan, /SEND_MAX_ATTEMPTS/);
  assert.match(r.pesan, /bukan angka yang sah/);
});

test('Math.max(1, NaN) bukan penjaga — dikunci di sini', () => {
  // Penjaga lama terlihat menutup kasus ini, padahal tidak. Test ini menjaga
  // agar tidak ada yang "menyederhanakan" validasi kembali ke bentuk itu.
  assert.ok(Number.isNaN(Math.max(1, NaN)), 'asumsi dasarnya berubah');
  const r = muatConfig({ SEND_MAX_ATTEMPTS: 'abc' });
  assert.strictEqual(r.ok, false);
});

test('nilai di luar batas ditolak, nilai sah tetap diterima', () => {
  assert.strictEqual(muatConfig({ SEND_MAX_ATTEMPTS: '0' }).ok, false, '0 di bawah minimum');
  assert.strictEqual(muatConfig({ PORT: '99999' }).ok, false, 'port di atas 65535');
  assert.strictEqual(muatConfig({ SEND_MAX_ATTEMPTS: '5' }).nilai, '5');
  assert.strictEqual(muatConfig({ SEND_MAX_ATTEMPTS: '' }).nilai, '3', 'kosong = pakai bawaan');
});

/* ============ C & A: butuh DB sementara ============ */

let tmp;
let svc;
let bRepo;
let rRepo;

test.before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-hard-'));
  process.env.DB_PATH = path.relative(ROOT, path.join(tmp, 'h.db'));
  process.env.AUTH_DIR = path.join(tmp, 'auth');
  process.env.UPLOAD_DIR = path.join(tmp, 'up');
  const sessionRepo = require('../src/repositories/sessionRepository');
  svc = require('../src/services/broadcastService');
  bRepo = require('../src/repositories/broadcastRepository');
  rRepo = require('../src/repositories/recipientRepository');
  sessionRepo.create({ id: 's1', name: 'S1', orgId: 'org-A' });
});

test.after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const buat = (recipients) =>
  svc.create(
    { sessionId: 's1', mode: 'queue', ratePerMinute: 10, messageText: 'halo', recipients },
    'org-A'
  );

/* ---- C: batas paginasi ditegakkan di service, bukan hanya controller ---- */

test('batas paginasi berlaku untuk pemanggil mana pun, bukan hanya HTTP', () => {
  // Di SQLite, LIMIT undefined maupun negatif berarti TANPA BATAS. Sebelumnya
  // penjaganya hanya ada di controller — pintu masuk kedua (gRPC, skrip, job)
  // yang lupa menirunya langsung menarik seluruh tabel.
  const asli = bRepo.list.bind(bRepo);
  const terlihat = [];
  bRepo.list = (arg) => {
    terlihat.push({ limit: arg.limit, offset: arg.offset });
    return asli(arg);
  };
  try {
    svc.list(undefined, 'org-A');
    svc.list({}, 'org-A');
    svc.list({ limit: 1000000 }, 'org-A');
    svc.list({ limit: -5, offset: -9 }, 'org-A');
    svc.list({ limit: 'abc' }, 'org-A');
    svc.list({ limit: 7, offset: 3 }, 'org-A');
  } finally {
    bRepo.list = asli;
  }

  for (const { limit, offset } of terlihat) {
    assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 500, `limit tak terbatas: ${limit}`);
    assert.ok(Number.isInteger(offset) && offset >= 0, `offset negatif: ${offset}`);
  }
  assert.deepStrictEqual(terlihat.at(-1), { limit: 7, offset: 3 }, 'nilai sah harus lewat apa adanya');
  assert.strictEqual(terlihat[2].limit, 500, 'limit raksasa dipangkas ke plafon');
});

/* ---- A: pesan yang statusnya tidak pasti tidak dikirim ulang ---- */

test('penerima yang tertinggal "sending" TIDAK dikirim ulang setelah restart', () => {
  const b = buat('6283333333333, 6284444444444, 6285555555555');
  bRepo.markRunning(b.id);
  const rows = rRepo.findByBroadcastId(b.id);
  rRepo.updateStatus(rows[0].id, { status: 'sent', sentAt: new Date().toISOString() });
  rRepo.updateStatus(rows[1].id, { status: 'sending' }); // proses mati tepat di sini

  svc.recoverInProgress();

  const sesudah = rRepo.findByBroadcastId(b.id);
  const status = sesudah.map((r) => r.status);
  assert.deepStrictEqual(status, ['sent', 'failed', 'pending'],
    'yang "sending" harus jadi failed — bukan pending, karena pesannya mungkin sudah sampai');

  const gagal = sesudah.find((r) => r.status === 'failed');
  assert.match(gagal.error, /tidak pasti/, 'keterangannya harus menyebut ketidakpastian itu');

  // Tally ikut disinkronkan, kalau tidak angka akhirnya meleset.
  const setelah = bRepo.findById(b.id, 'org-A');
  assert.strictEqual(setelah.sentCount, 1);
  assert.strictEqual(setelah.failedCount, 1);
});

test('recalcCounts tidak melempar — cancel() sempat 500 total karenanya', () => {
  // recalcCounts memanggil findById(id) tanpa orgId, dan sejak penyaringan
  // tenant dipasang panggilan itu SELALU melempar.
  const b = buat('6281111111111, 6282222222222');
  const hasil = svc.cancel(b.id, 'org-A');
  assert.strictEqual(hasil.status, 'cancelled');
  assert.doesNotThrow(() => bRepo.recalcCounts(b.id));
});

/* ============ H: copyToBroadcast menjaga path-nya sendiri ============ */

test('copyToBroadcast menolak path di luar folder uploads', () => {
  // Penjaganya dulu ada di PEMANGGIL, bukan di fungsinya: yang menahan hanyalah
  // kebetulan bahwa satu-satunya pemanggil memanggil exists() lebih dulu.
  // Pemanggil baru yang lupa urutan itu membuka rantai penuh — berkas mana pun
  // di disk tersalin ke uploads/broadcasts/, lalu terkirim sebagai lampiran
  // WhatsApp DAN tersaji publik tanpa autentikasi di /uploads/broadcasts/.
  const mediaService = require('../src/services/mediaService');

  for (const jahat of ['../../../../etc/hosts', '../uploads-jahat/x.png', '/etc/hosts']) {
    assert.throws(
      () => mediaService.copyToBroadcast(999, jahat),
      /di luar folder uploads/,
      `"${jahat}" seharusnya ditolak`
    );
  }

  // Path yang sah lolos penjaga ini dan gagal di tahap berikutnya (berkasnya
  // memang tidak ada) — bukan ditolak penjaga. Bedanya penting: kalau penjaga
  // ikut menolak path yang sah, fitur medianya mati diam-diam.
  assert.throws(
    () => mediaService.copyToBroadcast(999, 'templates/tidak-ada.png'),
    (err) => err.code === 'ENOENT',
    'path sah seharusnya lolos penjaga, bukan ditolak'
  );
});
