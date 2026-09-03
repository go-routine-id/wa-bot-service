'use strict';

const path = require('node:path');
const swaggerJsdoc = require('swagger-jsdoc');

/**
 * Definisi dasar OpenAPI. Detail tiap endpoint ditulis sebagai anotasi
 * `@openapi` di berkas route — supaya dokumentasinya duduk tepat di sebelah
 * route yang ia jelaskan, dan lebih sulit terlupakan saat route berubah.
 */
const definition = {
  openapi: '3.0.3',
  info: {
    title: 'wa-bot-service API',
    version: '1.0.0',
    description: [
      'Backend broadcast WhatsApp. Seluruh endpoint di bawah `/api` terikat',
      'organisasi: data yang terlihat ditentukan oleh kredensial pemanggil,',
      'bukan oleh parameter request.',
      '',
      'Setiap respons membawa header `X-Request-ID`, dan setiap error',
      'menyertakan `request_id` di body — sebutkan id itu saat melaporkan',
      'masalah, ia menunjuk tepat ke satu baris log.',
    ].join('\n'),
  },
  servers: [{ url: '/', description: 'Server ini' }],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Access token dari account-service (login, token-exchange, atau ' +
          'system-token). Harus memegang izin yang dikonfigurasi di ' +
          'AUTH_REQUIRED_PERMISSION. Refresh token DITOLAK.',
      },
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description:
          'Kunci mentah milik service account, diintrospeksi lewat /auth/whoami. ' +
          'JANGAN dikirim bersamaan dengan Authorization — kombinasi keduanya ' +
          'ditolak 400.',
      },
      OrgHeader: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Organization-Id',
        description:
          'HANYA untuk kredensial yang tidak terikat organisasi (system account). ' +
          'Token yang sudah membawa org_id tidak bisa memakai header ini untuk ' +
          'berpindah organisasi.',
      },
    },
    responses: {
      Unauthorized: {
        description: 'Kredensial tidak ada, cacat, atau kedaluwarsa',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Forbidden: {
        description: 'Terautentikasi, tapi izinnya kurang',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      NotFound: {
        description: 'Tidak ditemukan — termasuk bila datanya milik organisasi lain',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      BadRequest: {
        description: 'Permintaan tidak valid',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'Sesi pengirim tidak ditemukan' },
          request_id: {
            type: 'string',
            nullable: true,
            example: '81058ddd-407a-4bfb-a8d1-5d37d16bf2d5',
            description: 'Sama dengan header X-Request-ID; dipakai mencari barisnya di log',
          },
        },
      },
    },
  },
  security: [{ BearerAuth: [] }],
};

/** Spec dirakit sekali saat modul dimuat — isi berkas route tidak berubah saat runtime. */
const spec = swaggerJsdoc({
  definition,
  apis: [path.join(__dirname, '..', 'routes', '*.js')],
});

module.exports = { spec };
