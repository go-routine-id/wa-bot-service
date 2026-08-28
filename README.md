# WA Broadcast

Web app broadcast WhatsApp memakai [whatsapp-web.js](https://wwebjs.dev/). Buka web → scan QR → buat template / broadcast → kirim ke daftar nomor dengan rate-limit & pilihan mode proses.

> ⚠️ **Risiko ban:** library ini mengotomasi WhatsApp Web (unofficial). Broadcast massal berisiko membuat nomor ter-block. Mulai dengan rate kecil (20/menit) dan mode `queue`.

## Fitur

- Scan QR saat web pertama dibuka (session tersimpan — tidak perlu scan ulang tiap restart)
- CRUD template broadcast (teks + opsional 1 gambar)
- Buat broadcast: pilih template ATAU teks langsung + gambar, daftar nomor dipisah koma
- Rate limit per broadcast (pesan/menit, default 20)
- Mode proses: `queue` (antrian, satu per satu) atau `parallel` (jalan bersama, risiko ban lebih tinggi)
- History broadcast + detail status per-recipient
- REST API + SQLite (better-sqlite3), arsitektur MVC clean

## Persyaratan

- Node.js v18+ (dikembangkan & diuji di v24)
- Chromium (di-download otomatis saat install; bila script postinstall diblokir, jalankan `npx puppeteer browsers install chrome`)

## Menjalankan

```bash
cp .env.example .env   # sesuaikan bila perlu (PORT default 3000)
npm install
npm run dev            # atau npm start
```

Buka `http://localhost:3000`, scan QR di tab **Koneksi** memakai HP kamu.

## Struktur

```
src/
  models/          # validasi & shape entitas
  repositories/    # akses SQLite (satu-satunya layer yang menulis SQL)
  services/        # logika bisnis: whatsapp, broadcast, runner, media
  controllers/     # handler HTTP
  routes/          # definisi route REST
  middleware/      # upload, error handler
  utils/           # helper (phone, sleep, httpError)
public/            # frontend vanilla (desktop only)
config/            # config + koneksi DB
db/migrations/     # skema SQLite
```

## REST API (ringkas)

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/connection/status` | status koneksi + QR (dipoll frontend) |
| POST | `/api/connection/rescan` | buat ulang koneksi (QR baru) |
| POST | `/api/connection/logout` | logout + hapus session |
| CRUD | `/api/templates` | kelola template |
| POST/DELETE | `/api/media` | upload/hapus gambar |
| POST | `/api/broadcasts` | buat broadcast `{ mode, ratePerMinute, recipients, templateId?|messageText?, mediaPath? }` |
| GET | `/api/broadcasts` · `/api/broadcasts/:id` | history + detail per-recipient |
| POST | `/api/broadcasts/:id/cancel` | batalkan broadcast |

## Catatan

- Recovery otomatis: saat server restart di tengah broadcast, proses lanjut; recipient yang sudah `sent` tidak dikirim ulang.
- File media broadcast di-copy ke `uploads/broadcasts/<id>/` sehingga hapus template tidak merusak history.
