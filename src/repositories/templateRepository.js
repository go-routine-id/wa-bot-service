'use strict';

const { getDb } = require('../../config/database');
const { requireOrg } = require('./tenant');

const db = getDb();

const COLUMNS = `id, name, text_content AS textContent, media_path AS mediaPath,
  created_at AS createdAt, updated_at AS updatedAt`;

const templateRepository = {
  create({ name, textContent, mediaPath = null, orgId }) {
    requireOrg(orgId, 'templateRepository.create');
    const info = db
      .prepare(
        `INSERT INTO templates (name, text_content, media_path, owner_org_id) VALUES (?, ?, ?, ?)`
      )
      .run(name, textContent, mediaPath, orgId);
    return this.findById(info.lastInsertRowid, orgId);
  },

  findById(id, orgId) {
    requireOrg(orgId, 'templateRepository.findById');
    return (
      db
        .prepare(`SELECT ${COLUMNS} FROM templates WHERE id = ? AND owner_org_id = ?`)
        .get(id, orgId) ?? null
    );
  },

  findAll(orgId) {
    requireOrg(orgId, 'templateRepository.findAll');
    return db
      .prepare(`SELECT ${COLUMNS} FROM templates WHERE owner_org_id = ? ORDER BY id DESC`)
      .all(orgId);
  },

  update(id, { name, textContent, mediaPath = null, orgId }) {
    requireOrg(orgId, 'templateRepository.update');
    db.prepare(
      `UPDATE templates
       SET name = ?, text_content = ?, media_path = ?, updated_at = datetime('now')
       WHERE id = ? AND owner_org_id = ?`
    ).run(name, textContent, mediaPath, id, orgId);
    return this.findById(id, orgId);
  },

  remove(id, orgId) {
    requireOrg(orgId, 'templateRepository.remove');
    db.prepare('DELETE FROM templates WHERE id = ? AND owner_org_id = ?').run(id, orgId);
  },

  /**
   * Cek apakah sebuah media_path masih dipakai template lain.
   *
   * SENGAJA lintas organisasi. Berkas media dibagi lewat path di disk, jadi
   * pertanyaannya "apakah masih ada yang memakai berkas ini?" — bukan "apakah
   * organisasi ini masih memakainya". Menyaring per organisasi di sini akan
   * menghapus berkas yang masih dipakai tenant lain.
   */
  findByMediaPathUnscoped(mediaPath) {
    return (
      db
        .prepare('SELECT id FROM templates WHERE media_path = ? LIMIT 1')
        .get(mediaPath) ?? null
    );
  },
};

module.exports = templateRepository;
