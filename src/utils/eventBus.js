'use strict';

const { EventEmitter } = require('node:events');

/**
 * Kanal peristiwa dalam-proses.
 *
 * Sengaja tanpa pengetahuan domain apa pun: repository memancarkan, lapisan
 * gRPC menyimak. Kalau ia tahu soal broadcast, repository akan bergantung pada
 * service — arah yang terbalik.
 *
 * Peristiwa dipancarkan dari REPOSITORY, bukan dari runner. Alasannya: status
 * penerima juga berubah di luar runner — pembatalan, pemulihan boot, penghapusan
 * sesi. Menaburkan emit() di sepuluh titik pemanggilan berarti cepat atau lambat
 * ada yang terlewat, dan stream yang diam-diam tidak lengkap jauh lebih sulit
 * disadari daripada stream yang mati sama sekali.
 *
 * Batas listener dinaikkan: tiap stream WatchBroadcast yang terbuka menambah
 * satu penyimak, dan 10 (bawaan Node) terlalu rendah untuk itu. Peringatan
 * kebocoran tetap menyala di angka yang lebih masuk akal.
 */
const bus = new EventEmitter();
bus.setMaxListeners(200);

const PERISTIWA = {
  PENERIMA_BERUBAH: 'recipient:changed',
  BROADCAST_BERUBAH: 'broadcast:changed',
};

module.exports = { bus, PERISTIWA };
