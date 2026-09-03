'use strict';

/**
 * Dokumentasi API: yang diuji bukan isi tulisannya, melainkan dua hal yang bisa
 * salah diam-diam — spec yang tidak mencakup seluruh route, dan halaman docs
 * yang tanpa sadar terbuka untuk siapa saja.
 */

const test = require('node:test');
const assert = require('node:assert');

const { spec } = require('../src/docs/openapi');

test('spec mencakup SEMUA route yang benar-benar terdaftar', () => {
  // Daftar route dibaca dari BERKAS ROUTE kita sendiri, bukan dari struktur
  // internal Express: Express 5 sudah mengganti layer.regexp dengan matchers,
  // dan test yang menempel pada internal seperti itu akan pecah lagi di versi
  // berikutnya — padahal yang ingin dijaga cuma "setiap route punya anotasi".
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src', 'routes');

  // Prefix tiap berkas route, dari router.use('/x', require('./y')) di index.js
  const index = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
  const prefix = { 'authInfoRoutes.js': '/api' };
  for (const m of index.matchAll(/router\.use\('([^']+)',\s*require\('\.\/([^']+)'\)\)/g)) {
    prefix[`${m[2]}.js`] = `/api${m[1]}`;
  }

  const nyata = new Set();
  for (const berkas of fs.readdirSync(dir)) {
    if (berkas === 'index.js') continue;
    const awalan = prefix[berkas];
    assert.ok(awalan !== undefined, `${berkas} tidak ter-mount di routes/index.js`);
    const isi = fs.readFileSync(path.join(dir, berkas), 'utf8');
    for (const m of isi.matchAll(/router\.(get|post|put|patch|delete)\('([^']*)'/g)) {
      const jalur = (awalan + m[2]).replace(/\/$/, '') || '/';
      nyata.add(`${m[1].toUpperCase()} ${jalur}`);
    }
  }
  assert.ok(nyata.size > 0, 'tidak ada route terbaca — pembacaannya sendiri yang rusak');

  const didokumentasikan = new Set();
  for (const [jalur, operasi] of Object.entries(spec.paths)) {
    // OpenAPI memakai {id}, Express memakai :id.
    const gaya = jalur.replace(/\{([^}]+)\}/g, ':$1');
    for (const m of Object.keys(operasi)) didokumentasikan.add(`${m.toUpperCase()} ${gaya}`);
  }

  const belum = [...nyata].filter((r) => !didokumentasikan.has(r)).sort();
  assert.deepStrictEqual(belum, [], `route tanpa anotasi @openapi:\n  ${belum.join('\n  ')}`);

  const hantu = [...didokumentasikan].filter((r) => !nyata.has(r)).sort();
  assert.deepStrictEqual(hantu, [], `didokumentasikan tapi route-nya tidak ada:\n  ${hantu.join('\n  ')}`);
});

test('ketiga cara autentikasi terdokumentasi', () => {
  const skema = Object.keys(spec.components.securitySchemes);
  for (const wajib of ['BearerAuth', 'ApiKeyAuth', 'OrgHeader']) {
    assert.ok(skema.includes(wajib), `skema ${wajib} hilang dari dokumentasi`);
  }
});

test('/api/auth-info ditandai TIDAK butuh kredensial', () => {
  // Satu-satunya endpoint publik. Kalau tandanya hilang, pembaca akan mengira
  // ia butuh token — padahal ia justru dipanggil sebelum token ada.
  assert.deepStrictEqual(spec.paths['/api/auth-info'].get.security, []);
});
