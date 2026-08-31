'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classifySendError } = require('../src/utils/sendError');

test('error "detached Frame" boleh dicoba ulang', () => {
  // Pesan asli yang benar-benar muncul saat broadcast #111 gagal.
  const { retryable, message } = classifySendError(
    new Error("Attempted to use detached Frame '03AC1471F500B2F9A64CC4DA0378F488'.")
  );
  assert.strictEqual(retryable, true);
  // Pengguna tidak boleh disodori id frame Puppeteer.
  assert.ok(!message.includes('03AC1471'), `pesan masih mentah: ${message}`);
  assert.match(message, /memuat ulang/i);
});

test('konteks eksekusi hilang juga boleh dicoba ulang', () => {
  for (const raw of [
    'Execution context was destroyed, most likely because of a navigation.',
    'Cannot find context with specified id',
  ]) {
    assert.strictEqual(classifySendError(new Error(raw)).retryable, true, raw);
  }
});

test('"Target closed" TIDAK dicoba ulang — status pesan tidak pasti', () => {
  const { retryable, message } = classifySendError(
    new Error('Protocol error (Runtime.callFunctionOn): Target closed')
  );
  assert.strictEqual(
    retryable,
    false,
    'error yang bisa terjadi di tengah panggilan tidak boleh diulang otomatis: penerima bisa dapat pesan dua kali'
  );
  // Keraguannya harus disampaikan, bukan disembunyikan.
  assert.match(message, /mungkin sudah terkirim/i);
});

test('error lain diteruskan apa adanya', () => {
  const { retryable, message } = classifySendError(new Error('Phone number is not registered'));
  assert.strictEqual(retryable, false);
  assert.strictEqual(message, 'Phone number is not registered');
});

test('nilai non-Error tidak membuat crash', () => {
  assert.strictEqual(classifySendError('boom').message, 'boom');
  assert.strictEqual(classifySendError(null).retryable, false);
});
