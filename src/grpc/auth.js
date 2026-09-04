'use strict';

const grpc = require('@grpc/grpc-js');
const crypto = require('node:crypto');
const { authenticate } = require('../middleware/auth');

/**
 * Adapter autentikasi untuk gRPC.
 *
 * Verifikasinya TIDAK diulang di sini — ia memanggil authenticate() yang sama
 * dipakai jalur HTTP. Yang berbeda hanya sumber kredensialnya (metadata,
 * bukan header) dan cara menerjemahkan kegagalannya (kode gRPC, bukan status
 * HTTP). Menyalin logikanya akan membuat dua pintu masuk menyimpang, dan celah
 * yang hanya ada di satu pintu adalah yang paling sulit ditemukan.
 */

/** Ambil satu nilai metadata; gRPC menyimpannya sebagai array. */
function metaSatu(metadata, kunci) {
  const nilai = metadata.get(kunci);
  return nilai && nilai.length ? String(nilai[0]) : '';
}

// Sama seperti jalur HTTP: id dari luar dibatasi bentuknya karena ia ikut
// tercetak di log dan dipantulkan balik ke pemanggil.
const POLA_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function requestIdDari(metadata) {
  const dari = metaSatu(metadata, 'x-request-id').trim();
  return POLA_REQUEST_ID.test(dari) ? dari : crypto.randomUUID();
}

/** HTTP status → kode gRPC. Dipetakan eksplisit, bukan ditebak dari pesan. */
const KODE = {
  400: grpc.status.INVALID_ARGUMENT,
  401: grpc.status.UNAUTHENTICATED,
  403: grpc.status.PERMISSION_DENIED,
  404: grpc.status.NOT_FOUND,
  409: grpc.status.ALREADY_EXISTS,
  429: grpc.status.RESOURCE_EXHAUSTED,
  503: grpc.status.UNAVAILABLE,
};

function keGrpcError(err, requestId) {
  const status = err && err.statusCode;
  const code = KODE[status] || grpc.status.INTERNAL;

  // Pesan 5xx tidak diteruskan apa adanya — isinya bisa memuat jalur file atau
  // detail SQLite. Sama seperti errorHandler HTTP.
  const pesan =
    code === grpc.status.INTERNAL
      ? 'Terjadi kesalahan pada server'
      : (err && err.message) || 'Permintaan gagal';

  const metadata = new grpc.Metadata();
  if (requestId) metadata.set('x-request-id', requestId);

  const e = new Error(pesan);
  e.code = code;
  e.details = pesan;
  e.metadata = metadata;
  return e;
}

/**
 * Bungkus handler: autentikasi dulu, lalu jalankan dengan konteks `auth`.
 * Kegagalan apa pun — termasuk yang tak terduga — diterjemahkan ke kode gRPC.
 */
function terlindungi(handler) {
  return async (call, callback) => {
    const requestId = requestIdDari(call.metadata);
    try {
      const auth = await authenticate({
        authorization: metaSatu(call.metadata, 'authorization'),
        apiKey: metaSatu(call.metadata, 'x-api-key'),
        organizationId: metaSatu(call.metadata, 'x-organization-id'),
      });
      return await handler({ call, auth, requestId }, callback);
    } catch (err) {
      if (!err || !err.statusCode) {
        console.error(`[grpc] error [${requestId}]:`, err);
      } else if (err.statusCode >= 500) {
        console.error(`[grpc] ${err.statusCode} [${requestId}]:`, err);
      } else {
        console.warn(`[grpc] ${err.statusCode} [${requestId}]: ${err.message}`);
      }
      const e = keGrpcError(err, requestId);
      if (callback) return callback(e);
      // Jalur streaming tidak punya callback. `emit('error')` — BUKAN destroy():
      // destroy() memutus soketnya tanpa mengirimkan status, sehingga klien
      // menggantung sampai timeout-nya sendiri alih-alih menerima NOT_FOUND.
      call.emit('error', e);
      return undefined;
    }
  };
}

module.exports = { terlindungi, keGrpcError, metaSatu, requestIdDari };
