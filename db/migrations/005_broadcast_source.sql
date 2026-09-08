-- 005_broadcast_source.sql — asal pembuatan broadcast & siapa pembuatnya.
--
-- source: jalur pembuatan broadcast — 'web' (UI mengirim header X-Client: web),
-- 'api' (REST apa adanya: curl, service account, integrasi), atau 'grpc'.
-- Baris yang sudah ada sebelum migrasi ini bernilai 'api' — pencatatan dimulai
-- sekarang, dan itu lebih jujur daripada menebak-nebak asal usulnya.
--
-- owner_account_id: klaim `sub` (id akun) dari kredensial pembuat, dipakai
-- admin platform untuk mengawasi siapa yang membuat broadcast lintas
-- organisasi. NULLABLE: baris lama dan jalur pembuatan latar tidak selalu
-- membawa konteks akun.

ALTER TABLE broadcasts ADD COLUMN source TEXT NOT NULL DEFAULT 'api'
  CHECK (source IN ('web', 'api', 'grpc'));

ALTER TABLE broadcasts ADD COLUMN owner_account_id TEXT;
