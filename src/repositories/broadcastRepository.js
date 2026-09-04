'use strict';

const { getDb } = require('../../config/database');
const { requireOrg } = require('./tenant');
const { INVALID_NUMBER_ERROR } = require('../models/broadcast');

const db = getDb();

/** Literal string aman untuk disisipkan ke SQL (konstanta kode, bukan input user). */
function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const COLUMNS = `b.id, b.template_id AS templateId, b.mode, b.rate_per_minute AS ratePerMinute,
  b.delay_seconds AS delaySeconds, b.message_text AS messageText, b.media_path AS mediaPath, b.status,
  b.total_recipients AS totalRecipients, b.sent_count AS sentCount, b.failed_count AS failedCount,
  b.session_id AS sessionId, s.name AS sessionName,
  (SELECT COUNT(*) FROM broadcast_recipients br
     WHERE br.broadcast_id = b.id
       AND br.status = 'failed'
       AND COALESCE(br.error, '') != ${sqlLiteral(INVALID_NUMBER_ERROR)}) AS retryableFailedCount,
  b.error, b.created_at AS createdAt, b.started_at AS startedAt, b.finished_at AS finishedAt`;

const FROM = `FROM broadcasts b LEFT JOIN sessions s ON s.id = b.session_id`;

const broadcastRepository = {
  /**
   * Method di repository ini terbagi dua:
   *   - BERSAINGAN ORGANISASI (create/findById/list/remove) — dipanggil dari
   *     jalur HTTP, wajib menyaring owner_org_id.
   *   - TRANSISI STATUS (markRunning, updateCounts, dst.) — dipanggil runner
   *     latar yang bekerja pada baris yang SUDAH ditentukan lewat jalur
   *     terotorisasi. Menyaring organisasi di sana tidak menambah keamanan dan
   *     justru memaksa konteks request masuk ke proses latar yang tidak punya.
   */
  create({
    templateId = null,
    sessionId = null,
    mode,
    ratePerMinute,
    delaySeconds = null,
    messageText,
    mediaPath = null,
    totalRecipients,
    orgId,
  }) {
    requireOrg(orgId, 'broadcastRepository.create');
    const info = db
      .prepare(
        `INSERT INTO broadcasts
           (template_id, session_id, mode, rate_per_minute, delay_seconds, message_text, media_path, total_recipients, owner_org_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        templateId,
        sessionId,
        mode,
        ratePerMinute,
        delaySeconds,
        messageText,
        mediaPath,
        totalRecipients,
        orgId
      );
    return this.findById(info.lastInsertRowid, orgId);
  },

  findById(id, orgId) {
    requireOrg(orgId, 'broadcastRepository.findById');
    return (
      db
        .prepare(`SELECT ${COLUMNS} ${FROM} WHERE b.id = ? AND b.owner_org_id = ?`)
        .get(id, orgId) ?? null
    );
  },

  /**
   * TANPA penyaring organisasi — hanya untuk runner latar (queue worker,
   * pemulihan saat boot) yang bekerja pada broadcast yang organisasinya sudah
   * ditetapkan saat dibuat. JANGAN dipanggil dari jalur HTTP.
   */
  findByIdUnscoped(id) {
    return db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE b.id = ?`).get(id) ?? null;
  },

  list({ limit = 50, offset = 0, orgId } = {}) {
    requireOrg(orgId, 'broadcastRepository.list');
    return db
      .prepare(
        `SELECT ${COLUMNS} ${FROM} WHERE b.owner_org_id = ? ORDER BY b.id DESC LIMIT ? OFFSET ?`
      )
      .all(orgId, limit, offset);
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
  /**
   * Dipanggil saat sebuah sesi dihapus. Sesi-nya sudah tersaring organisasi di
   * lapisan atas, tapi disaring lagi di sini: kalau suatu saat pemanggilnya
   * berubah, pembatalan tidak boleh menyentuh broadcast tenant lain.
   */
  findBySessionAndStatus(sessionId, statuses, orgId) {
    requireOrg(orgId, 'broadcastRepository.findBySessionAndStatus');
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
    // TIDAK mengembalikan baris hasilnya. Versi sebelumnya memanggil
    // findById(id) tanpa orgId, dan sejak penyaringan tenant dipasang, panggilan
    // itu SELALU melempar — membuat setiap pemanggil recalcCounts ikut gagal,
    // termasuk cancel() yang jadi 500 total. Keempat pemanggilnya memakai fungsi
    // ini sebagai pernyataan dan mengambil ulang barisnya sendiri dengan orgId
    // masing-masing, jadi nilai kembalian itu memang tidak pernah dibutuhkan.
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
  /** Lintas organisasi — lihat alasannya di templateRepository. */
  findByMediaPathUnscoped(mediaPath) {
    return (
      db
        .prepare('SELECT id FROM broadcasts WHERE media_path = ? LIMIT 1')
        .get(mediaPath) ?? null
    );
  },

  remove(id, orgId) {
    requireOrg(orgId, 'broadcastRepository.remove');
    db.prepare('DELETE FROM broadcasts WHERE id = ? AND owner_org_id = ?').run(id, orgId);
  },
};

module.exports = broadcastRepository;
