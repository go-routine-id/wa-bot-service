'use strict';

const { getDb } = require('../../config/database');

const db = getDb();

const COLUMNS = `id, template_id AS templateId, mode, rate_per_minute AS ratePerMinute,
  message_text AS messageText, media_path AS mediaPath, status,
  total_recipients AS totalRecipients, sent_count AS sentCount, failed_count AS failedCount,
  error, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt`;

const broadcastRepository = {
  create({ templateId = null, mode, ratePerMinute, messageText, mediaPath = null, totalRecipients }) {
    const info = db
      .prepare(
        `INSERT INTO broadcasts
           (template_id, mode, rate_per_minute, message_text, media_path, total_recipients)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(templateId, mode, ratePerMinute, messageText, mediaPath, totalRecipients);
    return this.findById(info.lastInsertRowid);
  },

  findById(id) {
    return db.prepare(`SELECT ${COLUMNS} FROM broadcasts WHERE id = ?`).get(id) ?? null;
  },

  list({ limit = 50, offset = 0 } = {}) {
    return db
      .prepare(`SELECT ${COLUMNS} FROM broadcasts ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(limit, offset);
  },

  markRunning(id) {
    db.prepare(
      `UPDATE broadcasts SET status = 'running', started_at = datetime('now') WHERE id = ?`
    ).run(id);
  },

  updateCounts(id, sentCount, failedCount) {
    db.prepare(
      'UPDATE broadcasts SET sent_count = ?, failed_count = ? WHERE id = ?'
    ).run(sentCount, failedCount, id);
  },

  markCompleted(id, sentCount, failedCount) {
    db.prepare(
      `UPDATE broadcasts
       SET status = 'completed', sent_count = ?, failed_count = ?, finished_at = datetime('now')
       WHERE id = ?`
    ).run(sentCount, failedCount, id);
  },

  markFailed(id, error, sentCount, failedCount) {
    db.prepare(
      `UPDATE broadcasts
       SET status = 'failed', error = ?, sent_count = ?, failed_count = ?, finished_at = datetime('now')
       WHERE id = ?`
    ).run(error, sentCount, failedCount, id);
  },

  markCancelled(id, sentCount, failedCount) {
    db.prepare(
      `UPDATE broadcasts
       SET status = 'cancelled', sent_count = ?, failed_count = ?, finished_at = datetime('now')
       WHERE id = ?`
    ).run(sentCount, failedCount, id);
  },

  /** Broadcast mode queue berikutnya yang belum diproses (FIFO by id). */
  findNextQueued() {
    return (
      db
        .prepare(
          `SELECT ${COLUMNS} FROM broadcasts
           WHERE mode = 'queue' AND status = 'pending'
           ORDER BY id ASC LIMIT 1`
        )
        .get() ?? null
    );
  },

  /** Broadcast yang perlu dipulihkan setelah restart: running (di-reset) + parallel pending (di-spawn ulang). */
  findRecoverable() {
    return db
      .prepare(
        `SELECT ${COLUMNS} FROM broadcasts
         WHERE status IN ('running','pending')
         ORDER BY id ASC`
      )
      .all();
  },

  /** Set media_path (dipakai setelah media di-copy ke folder broadcast). */
  setMediaPath(id, mediaPath) {
    db.prepare('UPDATE broadcasts SET media_path = ? WHERE id = ?').run(mediaPath, id);
  },

  /** Reset broadcast ke 'pending' saat recovery restart (running → pending). */
  resetToPending(id) {
    db.prepare(
      `UPDATE broadcasts
       SET status = 'pending', started_at = NULL, finished_at = NULL, error = NULL
       WHERE id = ?`
    ).run(id);
  },

  /** Cek apakah sebuah media_path masih direferensikan broadcast manapun. */
  findByMediaPath(mediaPath) {
    return (
      db
        .prepare('SELECT id FROM broadcasts WHERE media_path = ? LIMIT 1')
        .get(mediaPath) ?? null
    );
  },

  remove(id) {
    db.prepare('DELETE FROM broadcasts WHERE id = ?').run(id);
  },
};

module.exports = broadcastRepository;
