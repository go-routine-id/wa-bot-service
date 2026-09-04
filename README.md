# WA Bot Service

Backend REST API untuk WhatsApp bot memakai [whatsapp-web.js](https://wwebjs.dev/) (WhatsApp Web resmi di headless Chromium, via Puppeteer): **kelola beberapa sesi WhatsApp** (beberapa nomor) → buat template / broadcast → kirim dari sesi pengirim yang dipilih ke daftar nomor, dengan rate-limit & pilihan mode proses.

Frontend web ada di repo terpisah: [**wa-bot-web**](https://github.com/go-routine-id/wa-bot-web).

> ⚠️ **Risiko ban:** library ini mengotomasi WhatsApp Web (unofficial). Broadcast massal berisiko membuat nomor ter-block. Mulai dengan rate kecil (20/menit) dan mode `queue`.

## Konsep: sesi

- **Satu sesi = satu nomor WhatsApp yang di-pair** lewat QR atau kode pairing. Kamu bisa pair beberapa nomor sekaligus (`utama`, `bisnis`, `cs`, …) dan tiap nomor berjalan independen.
- Saat membuat broadcast, kamu **memilih satu sesi sebagai pengirim**. Broadcast lama (sebelum fitur multi-sesi) tidak punya sesi → ditandai `—` di history.
- Sesi disimpan di `AUTH_DIR/session-<sessionId>/` dan ter-persist di tabel `sessions`. Status runtime (QR, koneksi) hanya di memori.

## Jalur gRPC (server-to-server)

Kontraknya di `proto/wabot/v1/broadcast.proto`, dimuat saat runtime — tidak ada
langkah generate yang bisa terlupakan.

```env
GRPC_PORT=7431          # kosongkan untuk mematikan; server tidak dijalankan sama sekali
GRPC_HOST=127.0.0.1     # bawaan loopback saja
```

Port sengaja **bukan** 50051/50052: keduanya port gRPC yang lazim dipindai, dan
50051 sudah dipakai account-service.

**Autentikasi lewat metadata**, memakai fungsi verifikasi yang sama persis
dengan jalur HTTP — bukan salinan:

| Metadata | Keterangan |
|---|---|
| `authorization: Bearer <token>` | access token dari account-service |
| `x-api-key` | alternatif; **jangan** bersamaan dengan Bearer |
| `x-organization-id` | hanya untuk kredensial tanpa organisasi (system account) |
| `x-request-id` | opsional; dipantulkan balik dan ikut tercetak di log |

Data milik organisasi lain dibalas `NOT_FOUND`, bukan `PERMISSION_DENIED` —
membedakan keduanya sudah membocorkan keberadaan datanya.

**`WatchBroadcast`** mengalirkan perubahan status selama broadcast berjalan, dan
ditutup server saat status akhir tercapai. Peristiwa yang sudah lewat sebelum
stream dibuka tidak diputar ulang: panggil `GetBroadcast` dulu untuk keadaan
awal, lalu ikuti alirannya.

Media tidak diekspos di gRPC — unggah lewat `POST /api/media`, lalu kirim
`media_path` yang dikembalikannya.

**Wajib satu proses dengan server HTTP.** Runner menyimpan flag pembatalan dan
whatsappService menyimpan registry sesi di memori; kalau dipisah jadi proses
sendiri, pembatalan broadcast dan status sesi berhenti bekerja diam-diam — tanpa
error, hanya perintah yang tidak berefek.

## Dokumentasi API (Swagger)

Halaman docs ada di **`/docs`**, spec mentahnya di `/docs/openapi.json`.

Keduanya digembok basic auth. **Tanpa `SWAGGER_USER` dan `SWAGGER_PASSWORD`,
route-nya tidak didaftarkan sama sekali** — bukan sekadar dibiarkan terbuka —
supaya service yang ter-deploy tanpa sengaja tidak ikut membocorkan peta
endpoint-nya.

```env
SWAGGER_USER=docs
SWAGGER_PASSWORD=ganti-ini
```

Isi dokumentasinya ditulis sebagai anotasi `@openapi` di berkas `src/routes/*.js`,
jadi ia duduk tepat di sebelah route yang dijelaskannya. Tidak ada langkah
generate: spec dirakit saat proses start.

`test/docs.test.js` membaca berkas route lalu membandingkannya dengan spec —
route yang ditambah tanpa anotasi membuat test gagal, bukan ditemukan pembaca
dokumentasi belakangan.

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
| GET | `/api/auth-info` | **tanpa autentikasi** — memberi tahu frontend apakah autentikasi menyala dan ke mana harus login. Tanpa ini, klien yang belum punya token tidak tahu alamat account-service dan hanya melihat dinding 401 |
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

## Autentikasi & multi-organisasi

API ini diverifikasi terhadap **account-service** (pusat identitas ikavia) dan
seluruh datanya terisolasi per **organisasi**.

`ACCOUNT_SERVICE_URL` kosong = autentikasi **nonaktif**, dan itu dicetak
mencolok saat boot. Jangan dipakai di production: API ini bisa mengirim
WhatsApp dari nomor yang terhubung.

### Ketiga model identitas didukung

| Model | Kredensial | Organisasi (tenant) diambil dari |
|---|---|---|
| **Human account** | `Authorization: Bearer` dari `/auth/login` | klaim `org_id` |
| **Service account** | `Bearer` dari `/auth/token-exchange` | klaim `org_id` |
| **Service account** | `X-API-Key` mentah | `org_id` dari `/auth/whoami` |
| **System account** | `Bearer` dari `/auth/system-token` | header **`X-Organization-Id`** |

System account adalah kredensial level platform dan memang tidak terikat
organisasi, jadi ia menyebut organisasi tujuannya sendiri. Header itu **hanya**
dihormati bila kredensialnya tidak punya `org_id` — kredensial yang terikat
organisasi tidak bisa memakainya untuk keluar dari organisasinya.

Semua model wajib memegang izin `AUTH_REQUIRED_PERMISSION` (default
`wa-bot:*`). Di account-service, service key `wa-bot` otomatis menjadi
`wa-bot:*` di dalam JWT.

> **Jebakan yang perlu diketahui:** JWT hasil `token-exchange` mengambil izin
> dari *service grant* + `capabilities`, **bukan** dari kolom `permissions`
> milik API key. Jadi kunci yang sama bisa berhasil lewat `X-API-Key` tapi
> `403` setelah ditukar — periksa grant-nya, bukan permission kuncinya.

### Data lama

Migrasi `004` menambahkan `owner_org_id` **tanpa menebak pemilik** baris yang
sudah ada. Baris lama karena itu tidak terlihat oleh siapa pun sampai
dihubungkan:

```bash
npm run claim-orphans -- <org_id>            # pratinjau
npm run claim-orphans -- <org_id> --commit   # menulis
```

`org_id` bisa dilihat dari `GET /api/v1/auth/whoami` di account-service.

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
| `SEND_MAX_ATTEMPTS` | `3` | Percobaan kirim per nomor saat WhatsApp Web memuat ulang halamannya. `1` = tanpa coba ulang |
| `SEND_RETRY_DELAY_SECONDS` | `3` | Jeda sebelum percobaan ulang |
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
| Recipient gagal: "WhatsApp Web sedang memuat ulang…" | Sudah dicoba ulang otomatis sampai `SEND_MAX_ATTEMPTS` dan tetap gagal — jalankan **Kirim ulang yang gagal** |
| Recipient gagal: "…pesan mungkin sudah terkirim" | Koneksi putus DI TENGAH pengiriman, jadi statusnya tidak pasti. Cek dulu ke penerimanya sebelum mengirim ulang |

## Kenapa pengiriman bisa gagal sesaat

whatsapp-web.js mengendalikan WhatsApp Web di dalam Chromium. WhatsApp Web
**memuat ulang halamannya sendiri** dari waktu ke waktu (sinkronisasi sesi,
pembaruan versi, koneksi pulih), dan library menyuntik ulang skripnya lewat
handler `framenavigated`. Pengiriman yang jatuh tepat di jendela itu gagal
dengan error Puppeteer — bukan karena nomornya salah dan bukan tanda ter-ban.

Kegagalan seperti itu dibedakan jadi dua:

| Jenis | Contoh error asli | Perlakuan |
|---|---|---|
| Terbukti belum dieksekusi | `Attempted to use detached Frame '…'`, `Execution context was destroyed` | **Dicoba ulang otomatis** — Puppeteer melemparnya sebelum kode masuk ke halaman, jadi pesan tidak mungkin terkirim dua kali |
| Status tidak pasti | `Target closed`, `Session closed` | **Tidak** diulang otomatis. Bisa terjadi di tengah panggilan, jadi pesannya mungkin sudah masuk; mengulang berisiko penerima dapat dua pesan sekaligus menambah risiko ban |

## Catatan

- Recovery otomatis: saat server restart di tengah broadcast, proses lanjut per sesi; recipient yang sudah `sent` tidak dikirim ulang.
- Hapus sesi saat ada broadcast berjalan → broadcast jadi `cancelled` (recipient tersisa di-skip "Sesi pengirim dihapus"), history tetap utuh.
- File media broadcast di-copy ke `uploads/broadcasts/<id>/` sehingga hapus template tidak merusak history.
