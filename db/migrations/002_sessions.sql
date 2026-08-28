-- 002_sessions.sql — multi-session WhatsApp
-- Sesi = hasil pairing satu nomor. id = slug stabil (cth 'utama'); name = label UI (bisa diubah).

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,             -- slug stabil: 'utama', 'promo-ramadan'
  name       TEXT NOT NULL,                -- label tampilan (bebas, bisa di-rename)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Kolom sesi pengirim per broadcast (NULL = broadcast legacy pra-multi-session).
-- ON DELETE SET NULL: hapus sesi tidak merusak history broadcast (kolom tampil "—").
ALTER TABLE broadcasts ADD COLUMN session_id TEXT
  REFERENCES sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_broadcasts_session ON broadcasts(session_id, status);
