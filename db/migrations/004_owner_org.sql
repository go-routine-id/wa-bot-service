-- Kepemilikan per organisasi (tenant) untuk integrasi account-service.
--
-- NULLABLE dan TANPA backfill, disengaja: baris yang sudah ada dibiarkan yatim
-- sampai pemiliknya dihubungkan manual. Konsekuensinya baris lama TIDAK terlihat
-- oleh siapa pun sampai itu dilakukan — lebih baik daripada menebak pemiliknya
-- dan salah memberikan data satu tenant ke tenant lain.
--
-- Sumber nilainya: klaim `org_id` pada JWT account-service, atau header
-- X-Organization-Id untuk system account yang memang tidak terikat organisasi.

ALTER TABLE sessions   ADD COLUMN owner_org_id TEXT;
ALTER TABLE templates  ADD COLUMN owner_org_id TEXT;
ALTER TABLE broadcasts ADD COLUMN owner_org_id TEXT;

-- Index dipasang karena SETIAP query menyaring kolom ini. Tanpa index, seluruh
-- pembacaan berubah jadi full scan begitu jumlah tenant bertambah.
CREATE INDEX IF NOT EXISTS idx_sessions_org   ON sessions(owner_org_id);
CREATE INDEX IF NOT EXISTS idx_templates_org  ON templates(owner_org_id);
-- Gabungan dengan status: daftar broadcast selalu disaring org DAN status.
CREATE INDEX IF NOT EXISTS idx_broadcasts_org ON broadcasts(owner_org_id, status);
