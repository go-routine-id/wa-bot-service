'use strict';

const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const config = require('../../config');
const { broadcastHandlers, sessionHandlers } = require('./handlers');

const PROTO_PATH = path.join(config.root, 'proto', 'wabot', 'v1', 'broadcast.proto');

/**
 * Server gRPC.
 *
 * Dimuat dari .proto saat runtime, tanpa codegen: project ini tidak punya
 * langkah build, dan menambahkan generator berarti menambah langkah yang bisa
 * terlupakan — kontrak dan kode lalu menyimpang tanpa ada yang menegur.
 *
 * WAJIB SATU PROSES dengan server HTTP. broadcastRunner menyimpan cancelFlags
 * dan whatsappService menyimpan registry sesi DI MEMORI. Kalau server ini
 * dipisah jadi proses sendiri, pembatalan broadcast dan status sesi akan
 * diam-diam berhenti bekerja — tanpa error, hanya perintah yang tidak berefek.
 */
function buatServer() {
  const definisi = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, // nama field proto dipertahankan (snake_case), tidak diubah
    longs: String, // int64 sebagai string: melampaui Number.MAX_SAFE_INTEGER itu senyap
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(definisi).wabot.v1;

  const server = new grpc.Server();
  server.addService(pkg.BroadcastService.service, broadcastHandlers);
  server.addService(pkg.SessionService.service, sessionHandlers);
  return server;
}

/**
 * Jalankan server gRPC bila GRPC_PORT diisi.
 *
 * Tanpa port, server TIDAK dijalankan sama sekali — pola yang sama dengan
 * halaman dokumentasi. Deployment yang tidak membutuhkan jalur ini tidak
 * membuka port tambahan tanpa disadari.
 */
function mulaiGrpc() {
  if (!config.grpcPort) {
    console.log('[grpc] nonaktif — GRPC_PORT belum diisi');
    return null;
  }
  const server = buatServer();
  const alamat = `${config.grpcHost}:${config.grpcPort}`;
  return new Promise((resolve, reject) => {
    server.bindAsync(alamat, grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) return reject(err);
      console.log(`[grpc] berjalan di ${config.grpcHost}:${port}`);
      resolve(server);
    });
  });
}

module.exports = { buatServer, mulaiGrpc, PROTO_PATH };
