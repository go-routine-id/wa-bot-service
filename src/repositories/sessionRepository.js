'use strict';

const { getDb } = require('../../config/database');
const { requireOrg } = require('./tenant');

const db = getDb();

const COLUMNS = `id, name, created_at AS createdAt`;

/**
 * Seluruh method menerima `orgId` dan menyaringnya. Baris milik organisasi lain
 * tidak pernah terbaca, dan update/delete lintas organisasi tidak mengenai baris
 * mana pun — pemanggil melihatnya sebagai "tidak ditemukan", yang benar: memberi
 * tahu bahwa sebuah id ADA di organisasi lain pun sudah bocor.
 */
const sessionRepository = {
  create({ id, name, orgId }) {
    requireOrg(orgId, 'sessionRepository.create');
    db.prepare('INSERT INTO sessions (id, name, owner_org_id) VALUES (?, ?, ?)').run(
      id,
      name,
      orgId
    );
    return this.findById(id, orgId);
  },

  findById(id, orgId) {
    requireOrg(orgId, 'sessionRepository.findById');
    return (
      db
        .prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ? AND owner_org_id = ?`)
        .get(id, orgId) ?? null
    );
  },

  /** Urutkan sesuai urutan pembuatan (rowid = urutan insert). */
  findAll(orgId) {
    requireOrg(orgId, 'sessionRepository.findAll');
    return db
      .prepare(`SELECT ${COLUMNS} FROM sessions WHERE owner_org_id = ? ORDER BY rowid ASC`)
      .all(orgId);
  },

  updateName(id, name, orgId) {
    requireOrg(orgId, 'sessionRepository.updateName');
    db.prepare('UPDATE sessions SET name = ? WHERE id = ? AND owner_org_id = ?').run(
      name,
      id,
      orgId
    );
    return this.findById(id, orgId);
  },

  remove(id, orgId) {
    requireOrg(orgId, 'sessionRepository.remove');
    db.prepare('DELETE FROM sessions WHERE id = ? AND owner_org_id = ?').run(id, orgId);
  },

  /**
   * Cari sesi TANPA menyaring organisasi.
   *
   * Hanya untuk proses latar yang tidak punya konteks request: pemulihan
   * broadcast saat boot dan queue worker. Keduanya bekerja dari baris broadcast
   * yang organisasinya sudah ditentukan saat dibuat, jadi tidak ada keputusan
   * otorisasi yang diambil di sini. JANGAN dipakai dari jalur HTTP.
   */
  findByIdUnscoped(id) {
    return db.prepare(`SELECT ${COLUMNS}, owner_org_id AS ownerOrgId FROM sessions WHERE id = ?`).get(id) ?? null;
  },

  /** Semua sesi lintas organisasi — hanya untuk startAll() saat boot. */
  findAllUnscoped() {
    return db.prepare(`SELECT ${COLUMNS}, owner_org_id AS ownerOrgId FROM sessions ORDER BY rowid ASC`).all();
  },
};

module.exports = sessionRepository;
