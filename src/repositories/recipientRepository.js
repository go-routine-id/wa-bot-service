'use strict';

const { getDb } = require('../../config/database');

const db = getDb();

const COLUMNS = `id, broadcast_id AS broadcastId, recipient_number AS recipientNumber,
  status, error, sent_at AS sentAt`;

const recipientRepository = {
  /**
   * Insert batch recipient. items: [{ number, status, error }].
   * INSERT OR IGNORE = backstop dedupe (UNIQUE broadcast_id+recipient_number).
   * Mengembalikan jumlah baris yang benar-benar ter-insert.
   */
  bulkInsert(broadcastId, items) {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO broadcast_recipients (broadcast_id, recipient_number, status, error)
       VALUES (?, ?, ?, ?)`
    );
    const insert = db.transaction(() => {
      let inserted = 0;
      for (const item of items) {
        const info = stmt.run(broadcastId, item.number, item.status, item.error ?? null);
        inserted += info.changes;
      }
      return inserted;
    });
    return insert();
  },

  findByBroadcastId(broadcastId) {
    return db
      .prepare(`SELECT ${COLUMNS} FROM broadcast_recipients WHERE broadcast_id = ? ORDER BY id ASC`)
      .all(broadcastId);
  },

  /** Recipient yang belum diproses (status pending) untuk sebuah broadcast. */
  findPending(broadcastId) {
    return db
      .prepare(
        `SELECT ${COLUMNS} FROM broadcast_recipients
         WHERE broadcast_id = ? AND status = 'pending'
         ORDER BY id ASC`
      )
      .all(broadcastId);
  },

  updateStatus(id, { status, error = null, sentAt = null }) {
    db.prepare(
      `UPDATE broadcast_recipients SET status = ?, error = ?, sent_at = ? WHERE id = ?`
    ).run(status, error, sentAt, id);
  },

  /** Update massal status berdasarkan status asal (untuk cancel / recovery). */
  bulkUpdateStatus(broadcastId, fromStatuses, toStatus, error = null) {
    if (fromStatuses.length === 0) return 0;
    const placeholders = fromStatuses.map(() => '?').join(',');
    const info = db
      .prepare(
        `UPDATE broadcast_recipients
         SET status = ?, error = ?
         WHERE broadcast_id = ? AND status IN (${placeholders})`
      )
      .run(toStatus, error, broadcastId, ...fromStatuses);
    return info.changes;
  },
};

module.exports = recipientRepository;
