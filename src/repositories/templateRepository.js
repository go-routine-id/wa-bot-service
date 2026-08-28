'use strict';

const { getDb } = require('../../config/database');

const db = getDb();

const COLUMNS = `id, name, text_content AS textContent, media_path AS mediaPath,
  created_at AS createdAt, updated_at AS updatedAt`;

const templateRepository = {
  create({ name, textContent, mediaPath = null }) {
    const info = db
      .prepare(`INSERT INTO templates (name, text_content, media_path) VALUES (?, ?, ?)`)
      .run(name, textContent, mediaPath);
    return this.findById(info.lastInsertRowid);
  },

  findById(id) {
    return db.prepare(`SELECT ${COLUMNS} FROM templates WHERE id = ?`).get(id) ?? null;
  },

  findAll() {
    return db.prepare(`SELECT ${COLUMNS} FROM templates ORDER BY id DESC`).all();
  },

  update(id, { name, textContent, mediaPath = null }) {
    db.prepare(
      `UPDATE templates
       SET name = ?, text_content = ?, media_path = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(name, textContent, mediaPath, id);
    return this.findById(id);
  },

  remove(id) {
    db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  },

  /** Cek apakah sebuah media_path masih dipakai template lain. */
  findByMediaPath(mediaPath) {
    return (
      db
        .prepare('SELECT id FROM templates WHERE media_path = ? LIMIT 1')
        .get(mediaPath) ?? null
    );
  },
};

module.exports = templateRepository;
