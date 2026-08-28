-- 001_init.sql — schema awal wa-bot-broadcast
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Template pesan broadcast (teks + opsional satu gambar)
CREATE TABLE IF NOT EXISTS templates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  text_content TEXT    NOT NULL,
  media_path   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Satu run broadcast
CREATE TABLE IF NOT EXISTS broadcasts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id      INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  mode             TEXT    NOT NULL CHECK (mode IN ('queue','parallel')),
  rate_per_minute  INTEGER NOT NULL CHECK (rate_per_minute BETWEEN 1 AND 3600),
  message_text     TEXT    NOT NULL,
  media_path       TEXT,
  status           TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','completed','failed','cancelled')),
  total_recipients INTEGER NOT NULL DEFAULT 0,
  sent_count       INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  started_at       TEXT,
  finished_at      TEXT
);

-- Hasil per-recipient (satu baris per nomor tujuan)
CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id      INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  recipient_number  TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sending','sent','failed','skipped')),
  error             TEXT,
  sent_at           TEXT,
  UNIQUE (broadcast_id, recipient_number)
);

CREATE INDEX IF NOT EXISTS idx_recipients_broadcast ON broadcast_recipients(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status);
