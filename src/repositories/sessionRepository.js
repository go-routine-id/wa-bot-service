'use strict';

const { getDb } = require('../../config/database');

const db = getDb();

const COLUMNS = `id, name, created_at AS createdAt`;

const sessionRepository = {
  create({ id, name }) {
    db.prepare('INSERT INTO sessions (id, name) VALUES (?, ?)').run(id, name);
    return this.findById(id);
  },

  findById(id) {
    return db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`).get(id) ?? null;
  },

  /** Urutkan sesuai urutan pembuatan (rowid = urutan insert). */
  findAll() {
    return db.prepare(`SELECT ${COLUMNS} FROM sessions ORDER BY rowid ASC`).all();
  },

  updateName(id, name) {
    db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, id);
    return this.findById(id);
  },

  remove(id) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  },
};

module.exports = sessionRepository;
