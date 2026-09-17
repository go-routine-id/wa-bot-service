'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildPuppeteerOptions } = require('../src/utils/puppeteerOptions');

test('handler sinyal bawaan puppeteer DIMATIKAN — graceful shutdown server yang pegang', () => {
  // Handler bawaan puppeteer membunuh Chrome seketika + process.exit(130),
  // berlomba dengan handler SIGINT/SIGTERM milik server.js. Bukti di pm2.log
  // box: deploy prod 2026-09-10 exit [130], restart 2026-09-16 exit [1],
  // dan nol baris "[shutdown]" di out.log — handler kita kalah lomba.
  const opts = buildPuppeteerOptions();
  assert.strictEqual(opts.handleSIGINT, false);
  assert.strictEqual(opts.handleSIGTERM, false);
  assert.strictEqual(opts.handleSIGHUP, false);
});

test('opsi dasar sandbox tetap utuh', () => {
  const opts = buildPuppeteerOptions();
  assert.strictEqual(opts.headless, true);
  assert.ok(opts.args.includes('--no-sandbox'));
  assert.ok(opts.args.includes('--disable-setuid-sandbox'));
  assert.ok(opts.args.includes('--disable-dev-shm-usage'));
});

test('tiap panggilan menghasilkan objek baru — aman dipakai banyak client', () => {
  // whatsapp-web.js menyalin/menambah args saat launch; objek yang dibagi
  // antar client bisa bocor mutasi antar sesi.
  const a = buildPuppeteerOptions();
  const b = buildPuppeteerOptions();
  assert.notStrictEqual(a, b);
  a.args.push('--mutasi');
  assert.ok(!b.args.includes('--mutasi'));
});
