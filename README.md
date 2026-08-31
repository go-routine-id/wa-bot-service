# WA Bot Service

Backend REST API untuk WhatsApp bot memakai [whatsapp-web.js](https://wwebjs.dev/) (WhatsApp Web resmi di headless Chromium, via Puppeteer): **kelola beberapa sesi WhatsApp** (beberapa nomor) → buat template / broadcast → kirim dari sesi pengirim yang dipilih ke daftar nomor, dengan rate-limit & pilihan mode proses.

Frontend web ada di repo terpisah: [**wa-bot-web**](https://github.com/go-routine-id/wa-bot-web).

> ⚠️ **Risiko ban:** library ini mengotomasi WhatsApp Web (unofficial). Broadcast massal berisiko membuat nomor ter-block. Mulai dengan rate kecil (20/menit) dan mode `queue`.

## Konsep: sesi

- **Satu sesi = satu nomor WhatsApp yang di-pair** lewat QR atau kode pairing. Kamu bisa pair beberapa nomor sekaligus (`utama`, `bisnis`, `cs`, …) dan tiap nomor berjalan independen.
- Saat membuat broadcast, kamu **memilih satu sesi sebagai pengirim**. Broadcast lama (sebelum fitur multi-sesi) tidak punya sesi → ditandai `—` di history.
- Sesi disimpan di `AUTH_DIR/session-<sessionId>/` dan ter-persist di tabel `sessions`. Status runtime (QR, koneksi) hanya di memori.

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

4. Buka `http://localhost:5173` → tab **Sesi WhatsApp** → ketik nama sesi → **Tambah Sesi** → scan QR dengan WhatsApp di HP.
5. Tambah sesi kedua bila perlu (tiap sesi = satu nomor, QR terpisah).
6. Tab **Buat Broadcast** → pilih **Sesi pengirim**, masukkan nomor (format `628...`), pilih template / tulis teks, atur rate & mode → **Kirim**.
7. Tab **History** → pantau status pengiriman per nomor, termasuk dari sesi mana tiap broadcast dikirim.

Status terhubung **tersimpan otomatis** — restart service tidak perlu scan ulang.

## Persyaratan

- Node.js v20+ (dikembangkan & diuji di v24)
- Chromium di-download otomatis oleh Puppeteer (dependency whatsapp-web.js) saat `npm install`

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

Perilaku ini berlaku **per sesi**:

| Fase | Perilaku |
|---|---|
| Tambah sesi baru | Status `connecting` → QR tampil di kartu sesi sampai ter-pair |
| QR (belum discan) | QR dirotasi library tanpa batas (`qrMaxRetries: 0`); kartu sesi selalu menampilkan QR terbaru selama polling jalan — jangan cache gambar QR pertama |
| Request manual | Klik **Request QR baru** → koneksi & QR baru dibuat |
| Pairing lewat kode | Klik **Kode pairing** → masukkan nomor HP → kode 8 karakter muncul (diperbarui tiap 3 menit). Hanya untuk sesi yang belum ter-pair |
| Setelah terhubung | Session tersimpan di `AUTH_DIR/session-<sessionId>`; restart service → auto-connect tanpa scan ulang |
| Koneksi putus setelah pernah terhubung | Auto-reconnect backoff (3–30 detik) memakai session tersimpan — **bukan pairing baru** |
| Sesi di-logout / auth_failure | Status `auth_failure` → klik rescan (kredensial dibuang, QR baru muncul) |
| Sesi dibuka instance lain | Status `disconnected` → klik **Hubungkan** untuk mengambil alih (take-over manual) |
| Logout | Sesi dihentikan dari WhatsApp; kredensial dihapus tapi baris sesi tetap ada (bisa scan ulang) |

> **Catatan:** tersedia dua jalur pairing — scan QR atau kode 8 karakter (`pairWithPhoneNumber` bawaan whatsapp-web.js). Satu sesi memakai salah satu jalur per percobaan koneksi.

## Format nomor

- Digit saja, tanpa `+`, `-`, spasi. Contoh: `6281234567890`
- Panjang valid: **8–15 digit**
- Pisahkan banyak nomor dengan koma, enter, atau spasi (duplikat dibuang otomatis)

## REST API

### Sesi WhatsApp

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/sessions` | daftar semua sesi + status runtime (dipoll frontend) |
| POST | `/api/sessions` | tambah sesi `{ name }` → id slug otomatis (cth. `promo-ramadan`); QR muncul segera |
| PATCH | `/api/sessions/:id` | rename `{ name }` (id sesi tetap — broadcast lama ikut menampilkan nama baru) |
| DELETE | `/api/sessions/:id` | hapus sesi + kredensial; broadcast pending/running yang memakainya dibatalkan |
| GET | `/api/sessions/:id/status` | status satu sesi |
| POST | `/api/sessions/:id/rescan` | buat ulang koneksi sesi (QR baru / hubungkan ulang) |
| POST | `/api/sessions/:id/pairing-code` | minta kode pairing 8 karakter `{ phone }` (hanya sesi yang belum ter-pair) |
| POST | `/api/sessions/:id/logout` | logout sesi dari WhatsApp (kredensial dihapus, baris tetap) |

### Broadcast & lainnya

| Method | Path | Keterangan |
|---|---|---|
| CRUD | `/api/templates` | kelola template (global, tidak terkait sesi) |
| POST/DELETE | `/api/media` | upload/hapus gambar |
| POST | `/api/broadcasts` | buat broadcast `{ sessionId, mode, ratePerMinute?\|delaySeconds?, recipients, templateId?\|messageText?, mediaPath? }` — **`sessionId` wajib** |
| GET | `/api/broadcasts` · `/api/broadcasts/:id` | history (termasuk `sessionName`) + detail per-recipient |
| POST | `/api/broadcasts/:id/cancel` | batalkan broadcast |
| POST | `/api/broadcasts/:id/retry` | kirim ulang recipient yang gagal (buat broadcast baru; mewarisi sesi pengirim asal). Broadcast tanpa sesi (legacy) → `400` |

Media di-serve di `/uploads/...` (mis. `http://localhost:3000/uploads/broadcasts/<id>/image.jpg`).

## Konfigurasi (env)

| Variable | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port HTTP server |
| `DB_PATH` | `db/wa-bot.db` | File SQLite |
| `UPLOAD_DIR` | `uploads` | Direktori media broadcast |
| `AUTH_DIR` | `.wwebjs_auth` | Session WhatsApp — per sesi di subfolder `session-<sessionId>/` |
| `DEFAULT_RATE_PER_MINUTE` | `20` | Rate default bila tidak diisi saat create |
| `MAX_RATE_PER_MINUTE` | `3600` | Batas atas rate; sekaligus batas **bawah** jeda per pesan (`60 / nilai ini`) |
| `MAX_DELAY_SECONDS` | `3600` | Batas atas jeda per pesan (detik) |
| `WARMUP_DELAY_SECONDS` | `0` | Jeda pemanasan (detik) sebelum pesan pertama broadcast — mitigasi anti-ban untuk device baru |
| `MAX_UPLOAD_SIZE` | `5242880` | Maks. ukuran gambar (5 MB) |
| `CORS_ORIGINS` | *(kosong)* | Origin web yang diizinkan (pisah koma) |
| `API_KEY` | *(kosong)* | API key untuk `/api`. Kosong = nonaktif. Klien mengirimnya lewat header `X-API-Key` (frontend: `localStorage.setItem('WA_API_KEY', '…')`) |

## Struktur

```
src/
  models/          # validasi & shape entitas
  repositories/    # akses SQLite (satu-satunya layer yang menulis SQL)
  services/        # logika bisnis: whatsapp (registry sesi), broadcast, runner, media
  controllers/     # handler HTTP
  routes/          # definisi route REST
  middleware/      # upload, CORS, error handler
  utils/           # helper (phone, sleep, httpError)
config/            # config + koneksi DB
db/migrations/     # skema SQLite (002_sessions: tabel sessions + kolom broadcasts.session_id)
uploads/           # media broadcast (dari env UPLOAD_DIR)
```

## Troubleshooting

| Masalah | Solusi |
|---|---|
| QR habis sebelum sempat discan | QR berlaku ~25 detik. Klik **Request QR baru** lalu scan lebih cepat |
| Status `qr_expired` muncul terus | Bukan error — memang desainnya: QR baru hanya dibuat saat diminta manual |
| Web tidak bisa membaca status API | Cek `CORS_ORIGINS` di `.env` service memuat origin web, dan `WA_API_BASE` di `config.js` web benar |
| Dropdown sesi pengirim kosong | Pastikan minimal satu sesi berstatus **terhubung** (tab Sesi WhatsApp) |
| Broadcast semua gagal | Cek format nomor (`628...`, 8–15 digit), pastikan sesi pengirim terhubung, dan sesi masih ada (belum dihapus) |
| Muncul `auth_failure` | Sesi di-logout/invalid dari WhatsApp — klik rescan (QR baru, scan ulang) |
| Nomor diblokir / ditegur WhatsApp | Kurangi rate (20/menit), pakai mode `queue`, jangan broadcast ke nomor tak dikenal |

## Catatan

- Recovery otomatis: saat server restart di tengah broadcast, proses lanjut per sesi; recipient yang sudah `sent` tidak dikirim ulang.
- Hapus sesi saat ada broadcast berjalan → broadcast jadi `cancelled` (recipient tersisa di-skip "Sesi pengirim dihapus"), history tetap utuh.
- File media broadcast di-copy ke `uploads/broadcasts/<id>/` sehingga hapus template tidak merusak history.
