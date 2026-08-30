-- Simpan jeda per pesan presisi (detik, boleh pecahan). NULL = mode rate (pesan/menit).
-- Sebelumnya delaySeconds dikonversi ke rate_per_minute integer → jeda > 60 detik
-- diam-diam ter-cap 60 detik & non-kelipatan dibulatkan kasar. Kolom ini membuat
-- runner tidur tepat sesuai jeda yang diminta.
ALTER TABLE broadcasts ADD COLUMN delay_seconds REAL;
