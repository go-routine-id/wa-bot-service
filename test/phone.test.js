'use strict';

/**
 * Normalisasi nomor.
 *
 * Dua cacat yang dikunci di sini pernah gagal DIAM-DIAM: nomor terlihat valid,
 * diterima tanpa keluhan, lalu tidak pernah sampai. Kegagalan seperti itu baru
 * ketahuan dari pelanggan yang tidak menerima pesan.
 */

const test = require('node:test');
const assert = require('node:assert');
const { normalizePhone, isValidPhone, parseTargets } = require('../src/utils/phone');

test('awalan lokal 0 diubah ke kode negara', () => {
  // Tanpa ini '085337949499' lolos validasi apa adanya lalu dikirim sebagai
  // '085337949499@c.us' — WhatsApp tidak menemukannya, dan tidak ada peringatan
  // apa pun karena nomornya terlihat sah.
  assert.strictEqual(normalizePhone('085337949499'), '6285337949499');
  assert.strictEqual(normalizePhone('0853 3794 9499'), '6285337949499');
  assert.strictEqual(normalizePhone('0853-3794-9499'), '6285337949499');
});

test('nomor yang sudah internasional tidak diutak-atik', () => {
  assert.strictEqual(normalizePhone('6285337949499'), '6285337949499');
  assert.strictEqual(normalizePhone('+62 853-3794-9499'), '6285337949499');
  // Negara lain dibiarkan: menebak-nebak di sini lebih berbahaya daripada diam.
  assert.strictEqual(normalizePhone('60123456789'), '60123456789');
  assert.strictEqual(normalizePhone('+1 415 555 0100'), '14155550100');
});

test('"0" saja tidak berubah jadi nomor yang tampak sah', () => {
  assert.strictEqual(isValidPhone(normalizePhone('0')), false);
  assert.strictEqual(isValidPhone(normalizePhone('00')), false);
});

test('spasi memisah bagian DALAM nomor, bukan antar nomor', () => {
  // Sebelumnya '[,;\\s]+' memecah di spasi: '+62 853-3794-9499' menjadi '+62'
  // dan '853-3794-9499', dan potongan kedua LOLOS sebagai nomor 85337949499 —
  // terlihat sah, lalu benar-benar dikirimi pesan. Nomor orang lain.
  for (const tulisan of ['0812 3456 7890', '+62 812 3456 7890', '0812-3456-7890', '(0812) 3456-7890']) {
    const { valid, invalid } = parseTargets(tulisan);
    assert.deepStrictEqual(valid, ['6281234567890'], `gagal untuk "${tulisan}"`);
    assert.deepStrictEqual(invalid, [], `"${tulisan}" tidak boleh menyisakan sampah`);
  }
});

test('koma dan baris baru tetap memisah antar nomor', () => {
  const { valid } = parseTargets('0812 3456 7890, 0853 3794 9499\n6289876543210');
  assert.deepStrictEqual(valid, ['6281234567890', '6285337949499', '6289876543210']);
});

test('dua nomor yang hanya dipisah spasi ditandai salah, bukan dikirim', () => {
  // Pertukaran yang disengaja: menyatu jadi satu entri panjang dan ditolak.
  // Terlihat salah lebih baik daripada diam-diam mengirim ke nomor keliru.
  const { valid, invalid } = parseTargets('0812 3456 7890 0813 4567 8901');
  assert.deepStrictEqual(valid, []);
  assert.strictEqual(invalid.length, 1);
});

test('penulisan berbeda untuk orang yang sama dihitung satu', () => {
  const { valid } = parseTargets('085337949499, 6285337949499, +62 853-3794-9499, 0853-3794-9499');
  assert.deepStrictEqual(valid, ['6285337949499'], 'dedup harus terjadi SETELAH normalisasi');
});
