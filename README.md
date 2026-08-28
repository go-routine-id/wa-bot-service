# WA Bot Service

Backend REST API untuk WhatsApp bot memakai [Baileys](https://github.com/WhiskeySockets/Baileys) (protokol WhatsApp Web multi-device langsung, tanpa browser) — scan QR → buat template / broadcast → kirim ke daftar nomor dengan rate-limit & pilihan mode proses.

Frontend web ada di repo terpisah: [**wa-bot-web**](https://github.com/go-routine-id/wa-bot-web).

> ⚠️ **Risiko ban:** library ini mengotomasi WhatsApp Web (unofficial). Broadcast massal berisiko membuat nomor ter-block. Mulai dengan rate kecil (20/menit) dan mode `queue`.

## Fitur

- Session WhatsApp (Baileys) persisten — scan QR sekali, tersimpan di `AUTH_DIR`
- QR auto-rotation + auto-reconnect dengan backoff saat koneksi putus
- Link preview otomatis untuk teks yang memuat URL (thumbnail link tampil, mis. Google Play)
- REST API: template, media upload, broadcast, history, cancel, retry
- Rate limit per broadcast (pesan/menit) + mode proses `queue` (antrian) / `parallel`
- Recovery otomatis saat server restart di tengah broadcast (recipient `sent` tidak di-resend)
- Kirim ulang recipient yang gagal (`POST /api/broadcasts/:id/retry`) — buat broadcast baru hanya dari nomor gagal, nomor terkirim tidak di-resend
- SQLite (better-sqlite3), arsitektur MVC clean

## Persyaratan

- Node.js v20+ (dikembangkan & diuji di v24) — Baileys v7 adalah ESM; dimuat via `import()` dinamis dari proyek CJS
- Tanpa Chromium/browser (koneksi langsung via WebSocket)

## Menjalankan

```bash
cp .env.example .env   # sesuaikan bila perlu (PORT default 3000, CORS_ORIGINS untuk mode terpisah)
npm install
npm run dev            # atau npm start
```

Service listen di `http://localhost:3000` — **API only** (tidak menyajikan frontend). Scan QR via frontend `wa-bot-web`, atau buka endpoint status di bawah ini.

### Mode terpisah (frontend di origin lain)

Web frontend (wa-bot-web) memanggil API ini lintas-origin. Izinkan origin web lewat env:

```bash
CORS_ORIGINS=http://localhost:5173
```

Kosong (`CORS_ORIGINS=`) = same-origin (backward-compatible).

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

## REST API (ringkas)

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

## Catatan

- Recovery otomatis: saat server restart di tengah broadcast, proses lanjut; recipient yang sudah `sent` tidak dikirim ulang.
- File media broadcast di-copy ke `uploads/broadcasts/<id>/` sehingga hapus template tidak merusak history.
