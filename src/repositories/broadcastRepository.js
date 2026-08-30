'use strict';

const { getDb } = require('../../config/database');

const db = getDb();

const COLUMNS = `b.id, b.template_id AS templateId, b.mode, b.rate_per_minute AS ratePerMinute,
  b.delay_seconds AS delaySeconds, b.message_text AS messageText, b.media_path AS mediaPath, b.status,
  b.total_recipients AS totalRecipients, b.sent_count AS sentCount, b.failed_count AS failedCount,
  b.session_id AS sessionId, s.name AS sessionName,
  (SELECT COUNT(*) FROM broadcast_recipients br
     WHERE br.broadcast_id = b.id
       AND br.status = 'failed'
       AND COALESCE(br.error, '') != 'invalid number') AS retryableFailedCount,
  b.error, b.created_at AS createdAt, b.started_at AS startedAt, b.finished_at AS finishedAt`;

const FROM = `FROM broadcasts b LEFT JOIN sessions s ON s.id = b.session_id`;

const broadcastRepository = {
  create({
    templateId = null,
    sessionId = null,
    mode,
    ratePerMinute,
    delaySeconds = null,
    messageText,
    mediaPath = null,
    totalRecipients,
  }) {
    const info = db
      .prepare(
        `INSERT INTO broadcasts
           (template_id, session_id, mode, rate_per_minute, delay_seconds, message_text, media_path, total_recipients)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        templateId,
        sessionId,
        mode,
        ratePerMinute,
        delaySeconds,
        messageText,
        mediaPath,
        totalRecipients
      );
    return this.findById(info.lastInsertRowid);
  },

  findById(id) {
    return db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE b.id = ?`).get(id) ?? null;
  },

  list({ limit = 50, offset = 0 } = {}) {
    return db
      .prepare(`SELECT ${COLUMNS} ${FROM} ORDER BY b.id DESC LIMIT ? OFFSET ?`)
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
          `SELECT ${COLUMNS} ${FROM}
           WHERE b.mode = 'queue' AND b.status = 'pending'
           ORDER BY b.id ASC LIMIT 1`
        )
        .get() ?? null
    );
  },

  /** Broadcast yang perlu dipulihkan setelah restart: running (di-reset) + parallel pending (di-spawn ulang). */
  findRecoverable() {
    return db
      .prepare(
        `SELECT ${COLUMNS} ${FROM}
         WHERE b.status IN ('running','pending')
         ORDER BY b.id ASC`
      )
      .all();
  },

  /** Broadcast milik satu sesi dengan status tertentu (dipakai cancelForSession). */
  findBySessionAndStatus(sessionId, statuses) {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    return db
      .prepare(
        `SELECT ${COLUMNS} ${FROM}
         WHERE b.session_id = ? AND b.status IN (${placeholders})
         ORDER BY b.id ASC`
      )
      .all(sessionId, ...statuses);
  },

  /**
   * Hitung ulang counter dari isi tabel recipient (bukan increment manual).
   * Dipakai setelah daftar recipient diubah (tambah/hapus nomor) supaya
   * total/sent/failed selalu cocok dengan baris yang benar-benar ada.
   */
  recalcCounts(id) {
    db.prepare(
      `UPDATE broadcasts SET
         total_recipients = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = ?),
         sent_count       = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'sent'),
         failed_count     = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'failed')
       WHERE id = ?`
    ).run(id, id, id, id);
    return this.findById(id);
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
