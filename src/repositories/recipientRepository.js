'use strict';

const { getDb } = require('../../config/database');
const { bus, PERISTIWA } = require('../utils/eventBus');

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

  /** Satu recipient by id (dipakai saat hapus: perlu cek status & broadcast pemiliknya). */
  findById(id) {
    return db.prepare(`SELECT ${COLUMNS} FROM broadcast_recipients WHERE id = ?`).get(id) ?? null;
  },

  /** Hapus satu recipient. Mengembalikan jumlah baris terhapus (0 = tidak ada). */
  remove(id) {
    return db.prepare('DELETE FROM broadcast_recipients WHERE id = ?').run(id).changes;
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
    // Baris dibaca ulang supaya penyimak menerima keadaan lengkapnya — termasuk
    // broadcast_id, yang tidak diketahui dari argumen. Satu SELECT tambahan per
    // perubahan status; pada laju kirim yang wajar (puluhan detik antar pesan)
    // biayanya tidak berarti.
    const baris = this.findById(id);
    if (baris) bus.emit(PERISTIWA.PENERIMA_BERUBAH, baris);
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
    if (info.changes > 0) {
      // Perubahan massal (batal, pemulihan, sesi dihapus) juga harus terlihat
      // penyimak. Dipancarkan per baris agar bentuk peristiwanya seragam.
      for (const baris of this.findByBroadcastId(broadcastId)) {
        bus.emit(PERISTIWA.PENERIMA_BERUBAH, baris);
      }
    }
    return info.changes;
  },
};

module.exports = recipientRepository;
