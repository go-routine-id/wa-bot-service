'use strict';

/**
 * Hubungkan data yatim (owner_org_id NULL) ke sebuah organisasi.
 *
 * Migrasi 004 menambahkan kepemilikan per organisasi TANPA menebak pemilik
 * baris yang sudah ada — menebak berarti berisiko menyerahkan data satu tenant
 * ke tenant lain. Konsekuensinya baris lama tidak terlihat oleh siapa pun
 * sampai skrip ini dijalankan.
 *
 * Pemakaian:
 *   node scripts/claim-orphans.js <org_id>            # pratinjau, TIDAK menulis
 *   node scripts/claim-orphans.js <org_id> --commit   # benar-benar menulis
 *
 * `org_id` diambil dari klaim `org_id` pada JWT account-service milikmu:
 *   curl -s $ACCOUNT/api/v1/auth/whoami -H "Authorization: Bearer $TOKEN"
 */

const { getDb } = require('../config/database');

const TABEL = ['sessions', 'templates', 'broadcasts'];

function main() {
  const [orgId, ...flags] = process.argv.slice(2);
  const commit = flags.includes('--commit');

  if (!orgId) {
    console.error('Pemakaian: node scripts/claim-orphans.js <org_id> [--commit]');
    process.exit(1);
  }

  const db = getDb();
  const yatim = {};
  let total = 0;
  for (const t of TABEL) {
    yatim[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE owner_org_id IS NULL`).get().n;
    total += yatim[t];
  }

  console.log(`\nOrganisasi tujuan : ${orgId}`);
  console.log('Baris yatim       :');
  for (const t of TABEL) console.log(`  ${t.padEnd(12)} ${yatim[t]}`);

  if (total === 0) {
    console.log('\nTidak ada yang perlu dihubungkan.\n');
    return;
  }

  if (!commit) {
    // Default-nya pratinjau. Skrip yang langsung menulis begitu dijalankan
    // terlalu mudah dieksekusi dengan org_id yang salah — dan salah di sini
    // berarti data muncul di organisasi yang keliru.
    console.log(`\n(pratinjau — tidak ada yang ditulis)`);
    console.log(`Jalankan lagi dengan --commit untuk menghubungkan ${total} baris.\n`);
    return;
  }

  // Satu transaksi: kalau gagal di tengah, jangan tinggalkan sebagian tabel
  // sudah dihubungkan dan sebagian belum.
  const jalankan = db.transaction(() => {
    const hasil = {};
    for (const t of TABEL) {
      hasil[t] = db
        .prepare(`UPDATE ${t} SET owner_org_id = ? WHERE owner_org_id IS NULL`)
        .run(orgId).changes;
    }
    return hasil;
  });

  const hasil = jalankan();
  console.log('\nDihubungkan:');
  for (const t of TABEL) console.log(`  ${t.padEnd(12)} ${hasil[t]}`);
  console.log('\nSelesai. Muat ulang halaman untuk melihatnya.\n');
}

main();
