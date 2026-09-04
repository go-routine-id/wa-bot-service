'use strict';

const grpc = require('@grpc/grpc-js');
const broadcastService = require('../services/broadcastService');
const whatsappService = require('../services/whatsappService');
const { bus, PERISTIWA } = require('../utils/eventBus');
const { terlindungi } = require('./auth');
const {
  broadcastKeProto,
  penerimaKeProto,
  sesiKeProto,
  createRequestKeBody,
} = require('./mapper');

/**
 * Handler gRPC.
 *
 * Semuanya memanggil service layer yang SAMA dipakai jalur HTTP — tidak ada
 * logika bisnis di sini, hanya terjemahan bentuk. Konsekuensinya penting:
 * penyaringan per organisasi, validasi, dan batas paginasi ikut terbawa tanpa
 * perlu diingat ulang. Kalau handler ini menyentuh repository langsung, semua
 * penjaga itu harus ditulis dua kali.
 */

const STATUS_AKHIR = new Set(['completed', 'failed', 'cancelled']);

const broadcastHandlers = {
  CreateBroadcast: terlindungi(async ({ call, auth }, callback) => {
    const hasil = broadcastService.create(createRequestKeBody(call.request), auth.orgId);
    callback(null, broadcastKeProto(hasil));
  }),

  ListBroadcasts: terlindungi(async ({ call, auth }, callback) => {
    // limit 0 = "tidak disebut" di proto3. Diteruskan sebagai undefined supaya
    // service yang memutuskan bawaannya, bukan diartikan sebagai nol baris.
    const { limit, offset } = call.request;
    const rows = broadcastService.list(
      { limit: limit || undefined, offset: offset || 0 },
      auth.orgId
    );
    callback(null, { broadcasts: rows.map(broadcastKeProto) });
  }),

  GetBroadcast: terlindungi(async ({ call, auth }, callback) => {
    const { broadcast, recipients } = broadcastService.getDetail(
      Number(call.request.id),
      auth.orgId
    );
    callback(null, {
      broadcast: broadcastKeProto(broadcast),
      recipients: recipients.map(penerimaKeProto),
    });
  }),

  CancelBroadcast: terlindungi(async ({ call, auth }, callback) => {
    callback(null, broadcastKeProto(broadcastService.cancel(Number(call.request.id), auth.orgId)));
  }),

  RetryBroadcast: terlindungi(async ({ call, auth }, callback) => {
    const hasil = broadcastService.retry(
      Number(call.request.id),
      { sessionId: call.request.session_id || undefined },
      auth.orgId
    );
    callback(null, broadcastKeProto(hasil));
  }),

  WatchBroadcast: terlindungi(async ({ call, auth }) => {
    const id = Number(call.request.id);

    // Kepemilikan diperiksa DULU, lewat service yang sama dipakai HTTP. Tanpa
    // ini, siapa pun yang menebak id bisa menyimak jalannya broadcast milik
    // organisasi lain — nomor tujuan ikut mengalir di peristiwanya.
    broadcastService.getDetail(id, auth.orgId); // melempar 404 bila bukan miliknya

    const onPenerima = (baris) => {
      if (Number(baris.broadcastId) !== id) return;
      call.write({ broadcast_id: id, recipient_changed: penerimaKeProto(baris) });
    };
    const onBroadcast = (baris) => {
      if (Number(baris.id) !== id) return;
      call.write({ broadcast_id: id, broadcast_changed: broadcastKeProto(baris) });
      // Status akhir → tutup stream. Klien tidak perlu menebak kapan selesai.
      if (STATUS_AKHIR.has(baris.status)) selesai();
    };

    let sudahSelesai = false;
    function selesai() {
      if (sudahSelesai) return;
      sudahSelesai = true;
      // WAJIB dilepas. Tiap stream menambah dua penyimak di bus yang berumur
      // sepanjang proses; tanpa pelepasan, stream yang datang-pergi menumpuk
      // penyimak mati sampai peringatan kebocoran menyala — dan setiap
      // peristiwa dikirim ke soket yang sudah tertutup.
      bus.off(PERISTIWA.PENERIMA_BERUBAH, onPenerima);
      bus.off(PERISTIWA.BROADCAST_BERUBAH, onBroadcast);
      call.end();
    }

    bus.on(PERISTIWA.PENERIMA_BERUBAH, onPenerima);
    bus.on(PERISTIWA.BROADCAST_BERUBAH, onBroadcast);

    // Klien memutus / batal / error → lepas juga. Ketiganya harus ditangani:
    // 'cancelled' saja tidak menutupi klien yang matinya tidak sopan.
    call.on('cancelled', selesai);
    call.on('close', selesai);
    call.on('error', selesai);
  }),
};

const sessionHandlers = {
  ListSessions: terlindungi(async ({ auth }, callback) => {
    const sesi = whatsappService.listSessions(auth.orgId);
    callback(null, { sessions: sesi.map(sesiKeProto) });
  }),
};

module.exports = { broadcastHandlers, sessionHandlers, grpc };
