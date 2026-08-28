# WA Bot Service

Backend REST API untuk WhatsApp bot memakai [Baileys](https://github.com/WhiskeySockets/Baileys) (protokol WhatsApp Web multi-device langsung, tanpa browser): scan QR → buat template / broadcast → kirim ke daftar nomor dengan rate-limit & pilihan mode proses.

Frontend web ada di repo terpisah: [**wa-bot-web**](https://github.com/go-routine-id/wa-bot-web).

> ⚠️ **Risiko ban:** library ini mengotomasi WhatsApp Web (unofficial). Broadcast massal berisiko membuat nomor ter-block. Mulai dengan rate kecil (20/menit) dan mode `queue`.

## Quickstart (pemakaian pertama, ±5 menit)

```bash
# 1. Clone kedua repo
git clone git@github.com:go-routine-id/wa-bot-service.git
git clone git@github.com:go-routine-id/wa-bot-web.git
cd wa-bot-service

# 2. Install & jalankan service
npm install
cp .env.example .env     # default port 3000, rate 20/menit — bisa dibiarkan dulu
npm run dev              # → http://localhost:3000

# 3. Terminal kedua — frontend
cd ../wa-bot-web
npm install
npm start                # → http://localhost:5173
```

Lalu di browser:

4. Buka `http://localhost:5173` → tab **Koneksi** → scan QR dengan WhatsApp di HP.
   **QR berlaku ~25 detik** — kalau habis, QR hilang dan cukup klik **Request QR baru**.
5. Tab **Buat Broadcast** → masukkan nomor (format `628...`), pilih template / tulis teks, atur rate & mode → **Kirim**.
6. Tab **History** → pantau status pengiriman per nomor.

Status terhubung **tersimpan otomatis** — restart service tidak perlu scan ulang.

## Persyaratan

- Node.js v20+ (dikembangkan & diuji di v24) — Baileys v7 adalah ESM; dimuat via `import()` dinamis dari proyek CJS
- Tanpa Chromium/browser (koneksi langsung via WebSocket)

## Menjalankan

```bash
npm run dev     # nodemon (auto-restart saat kode berubah)
# atau
npm start       # node biasa (production)
```

Service listen di `http://localhost:3000` — **API only** (tidak menyajikan frontend). Scan QR via frontend `wa-bot-web`, atau lihat endpoint status di bagian REST API.

### Mode terpisah & CORS

Web frontend memanggil API ini lintas-origin. Izinkan origin web lewat env:

```bash
CORS_ORIGINS=http://localhost:5173   # beberapa origin: pisah koma
```

Kosong (`CORS_ORIGINS=`) = same-origin (backward-compatible).

## Perilaku koneksi (penting)

| Fase | Perilaku |
|---|---|
| Service start | Koneksi dibuat otomatis; QR tampil di frontend bila belum ter-pair |
| QR (belum discan) | Berlaku **~25 detik**. Habis → status `qr_expired`, QR hilang, koneksi dihentikan |
| Request manual | Klik **Request QR baru** → koneksi & QR baru dibuat. **Tidak ada auto-refresh** |
| Setelah terhubung | Session tersimpan di `AUTH_DIR`; restart service → auto-connect tanpa scan ulang |
| Koneksi putus setelah pernah terhubung | Auto-reconnect backoff (3–30 detik) memakai session tersimpan — **bukan pairing baru** |
| Sesi invalid / di-logout | Status `auth_failure` → klik rescan (session dibuang, QR baru muncul) |

> **Kenapa tidak auto-refresh QR?** Percobaan pairing berulang secara otomatis ke server WhatsApp bisa terdeteksi sebagai perilaku tidak wajar (risiko banned). Karena itu QR baru hanya dibuat saat diminta manual — bukan berulang sendiri.

## Format nomor

- Digit saja, tanpa `+`, `-`, spasi. Contoh: `6281234567890`
- Panjang valid: **8–15 digit**
- Pisahkan banyak nomor dengan koma, enter, atau spasi (duplikat dibuang otomatis)

## REST API

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/connection/status` | status koneksi + QR (dipoll frontend) |
| POST | `/api/connection/rescan` | buat ulang koneksi (QR baru) |
| POST | `/api/connection/logout` | logout + hapus session |
| CRUD | `/api/templates` | kelola template |
| POST/DELETE | `/api/media` | upload/hapus gambar |
| POST | `/api/broadcasts` | buat broadcast `{ mode, ratePerMinute, recipients, templateId?\|messageText?, mediaPath? }` |
| GET | `/api/broadcasts` · `/api/broadcasts/:id` | history + detail per-recipient |
| POST | `/api/broadcasts/:id/cancel` | batalkan broadcast |
| POST | `/api/broadcasts/:id/retry` | kirim ulang recipient yang gagal (buat broadcast baru, nomor terkirim tidak di-resend) |

Media di-serve di `/uploads/...` (mis. `http://localhost:3000/uploads/broadcasts/<id>/image.jpg`).

## Konfigurasi (env)

| Variable | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port HTTP server |
| `DB_PATH` | `db/wa-bot.db` | File SQLite |
| `UPLOAD_DIR` | `uploads` | Direktori media broadcast |
| `AUTH_DIR` | `.baileys_auth` | Session WhatsApp (creds + keys) |
| `DEFAULT_RATE_PER_MINUTE` | `20` | Rate default bila tidak diisi saat create |
| `MAX_RATE_PER_MINUTE` | `3600` | Batas atas rate (validasi) |
| `MAX_UPLOAD_SIZE` | `5242880` | Maks. ukuran gambar (5 MB) |
| `CORS_ORIGINS` | *(kosong)* | Origin web yang diizinkan (pisah koma) |

## Struktur

```
src/
  models/          # validasi & shape entitas
  repositories/    # akses SQLite (satu-satunya layer yang menulis SQL)
  services/        # logika bisnis: whatsapp, broadcast, runner, media
  controllers/     # handler HTTP
  routes/          # definisi route REST
  middleware/      # upload, CORS, error handler
  utils/           # helper (phone, sleep, httpError)
config/            # config + koneksi DB
db/migrations/     # skema SQLite
uploads/           # media broadcast (dari env UPLOAD_DIR)
```

## Troubleshooting

| Masalah | Solusi |
|---|---|
| QR habis sebelum sempat discan | QR berlaku ~25 detik. Klik **Request QR baru** lalu scan lebih cepat |
| Status `qr_expired` muncul terus | Bukan error — memang desainnya: QR baru hanya dibuat saat diminta manual |
| Web tidak bisa membaca status API | Cek `CORS_ORIGINS` di `.env` service memuat origin web, dan `WA_API_BASE` di `config.js` web benar |
| Broadcast semua gagal | Cek format nomor (`628...`, 8–15 digit) dan pastikan status Koneksi = **terhubung** |
| Muncul `auth_failure` | Sesi di-logout/invalid dari WhatsApp — klik rescan (QR baru, scan ulang) |
| Nomor diblokir / ditegur WhatsApp | Kurangi rate (20/menit), pakai mode `queue`, jangan broadcast ke nomor tak dikenal |

## Catatan

- Recovery otomatis: saat server restart di tengah broadcast, proses lanjut; recipient yang sudah `sent` tidak dikirim ulang.
- File media broadcast di-copy ke `uploads/broadcasts/<id>/` sehingga hapus template tidak merusak history.
